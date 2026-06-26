/**
 * cv_converter.js
 * Converts a .docx file to PDF using Microsoft Word COM automation (Windows).
 * Falls back to LibreOffice if Word is not installed.
 */

const { execSync, spawnSync } = require('child_process');
const fs   = require('fs');
const path = require('path');

function wordAvailable() {
  // Fast check: look for WINWORD.EXE via registry rather than launching Word
  try {
    const r = spawnSync('powershell', [
      '-NoProfile', '-Command',
      '(Get-ItemProperty "HKLM:\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\WINWORD.EXE" -ErrorAction SilentlyContinue)."(default)"',
    ], { encoding: 'utf8', timeout: 5000 });
    const out = (r.stdout || '').trim();
    return out.length > 0 && out.toLowerCase().endsWith('.exe');
  } catch {
    return false;
  }
}

function libreOfficeAvailable() {
  try {
    const r = spawnSync('soffice', ['--version'], { encoding: 'utf8', timeout: 5000 });
    return r.status === 0;
  } catch {
    return false;
  }
}

function convertWithWord(docxPath, pdfPath) {
  const absDocs = path.resolve(docxPath);
  const absPdf  = path.resolve(pdfPath);

  // Write a temp .ps1 to avoid inline quoting issues with paths
  const ps1 = path.join(require('os').tmpdir(), `_jobbot_convert_${Date.now()}.ps1`);
  fs.writeFileSync(ps1, `
$word = New-Object -ComObject Word.Application
$word.Visible = $false
$word.DisplayAlerts = 0
$doc = $word.Documents.Open('${absDocs.replace(/'/g, "''")}', $false, $true)
$doc.SaveAs2('${absPdf.replace(/'/g, "''")}', 17)
$doc.Close($false)
$word.Quit()
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($doc) | Out-Null
[System.Runtime.InteropServices.Marshal]::ReleaseComObject($word) | Out-Null
[System.GC]::Collect()
[System.GC]::WaitForPendingFinalizers()
`, 'utf8');

  try {
    execSync(`powershell -NoProfile -ExecutionPolicy Bypass -File "${ps1}"`, { timeout: 60000 });
  } finally {
    fs.unlink(ps1, () => {});
  }
}

function convertWithLibreOffice(docxPath, pdfDir) {
  execSync(`soffice --headless --convert-to pdf --outdir "${pdfDir}" "${docxPath}"`, { timeout: 60000 });
}

async function convertDocxToPdf(docxPath, pdfPath) {
  if (!fs.existsSync(docxPath)) throw new Error(`Docx not found: ${docxPath}`);

  fs.mkdirSync(path.dirname(pdfPath), { recursive: true });

  if (wordAvailable()) {
    console.log('  [Converter] Using Microsoft Word for PDF conversion');
    convertWithWord(docxPath, pdfPath);
    if (!fs.existsSync(pdfPath)) throw new Error('Word conversion produced no output');
    return;
  }

  if (libreOfficeAvailable()) {
    console.log('  [Converter] Using LibreOffice for PDF conversion');
    const pdfDir      = path.dirname(pdfPath);
    const expectedPdf = path.join(pdfDir, path.basename(docxPath, '.docx') + '.pdf');
    convertWithLibreOffice(docxPath, pdfDir);
    if (!fs.existsSync(expectedPdf)) throw new Error('LibreOffice conversion produced no output');
    if (expectedPdf !== pdfPath) fs.renameSync(expectedPdf, pdfPath);
    return;
  }

  throw new Error('No PDF converter found — please install Microsoft Word or LibreOffice');
}

module.exports = { convertDocxToPdf };

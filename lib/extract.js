// In-memory document text extraction. Operates on multer memory-storage file
// objects ({ originalname, mimetype, buffer }). Nothing ever touches disk.

const mammoth = require('mammoth');

// pdf-parse's index pulls in a debug harness that reads a test file on load in
// some versions; require the library module directly to avoid that.
const pdfParse = require('pdf-parse');

function extOf(name) {
  const i = (name || '').lastIndexOf('.');
  return i === -1 ? '' : name.slice(i + 1).toLowerCase();
}

// Returns { text, scannedLikely }. scannedLikely flags PDFs/DOCX that yielded
// almost no extractable text (typically scanned images with no text layer).
async function extractText(file) {
  const ext = extOf(file.originalname);
  let text;

  if (ext === 'pdf') {
    const parsed = await pdfParse(file.buffer);
    text = parsed.text || '';
  } else if (ext === 'docx') {
    const result = await mammoth.extractRawText({ buffer: file.buffer });
    text = result.value || '';
  } else if (ext === 'txt') {
    text = file.buffer.toString('utf8');
  } else {
    const err = new Error(`Unsupported file type: .${ext || '?'}. Use PDF, DOCX, or TXT.`);
    err.status = 400;
    throw err;
  }

  const nonWs = text.replace(/\s/g, '').length;
  return { text, scannedLikely: nonWs < 20 };
}

module.exports = { extractText, extOf };

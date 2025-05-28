// youtube_shorts_organizer.js
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const { google } = require('googleapis');
const { GoogleAuth } = require('google-auth-library');
const openai = require('openai');
const cliProgress = require('cli-progress');

const DRIVE_FOLDER_ID = process.env.DRIVE_FOLDER_ID;
const LOCAL_VIDEO_DIR = path.resolve(__dirname, 'videos');
const TRANSCRIPTS_DIR = path.resolve(__dirname, 'transcripts');
const SPREADSHEET_ID = process.env.SPREADSHEET_ID;
const SHEET_NAME = 'Sheet1';

openai.apiKey = process.env.OPENAI_API_KEY;

if (!fs.existsSync(LOCAL_VIDEO_DIR)) fs.mkdirSync(LOCAL_VIDEO_DIR);
if (!fs.existsSync(TRANSCRIPTS_DIR)) fs.mkdirSync(TRANSCRIPTS_DIR);

async function authenticateGoogleAPIs() {
  const auth = new GoogleAuth({
    keyFile: 'credentials.json',
    scopes: ['https://www.googleapis.com/auth/drive', 'https://www.googleapis.com/auth/spreadsheets'],
  });
  return auth.getClient();
}

async function listDriveVideos(auth) {
  const drive = google.drive({ version: 'v3', auth });
  const res = await drive.files.list({
    q: `'${DRIVE_FOLDER_ID}' in parents and mimeType='video/mp4'`,
    fields: 'files(id, name)',
  });
  return res.data.files;
}

async function downloadVideo(auth, file) {
  const filePath = path.join(LOCAL_VIDEO_DIR, file.name);
  if (fs.existsSync(filePath)) return null;

  console.log(`[DOWNLOAD] Downloading: ${file.name}`);
  const bar = new cliProgress.SingleBar({}, cliProgress.Presets.shades_classic);
  bar.start(100, 0);

  const drive = google.drive({ version: 'v3', auth });
  const dest = fs.createWriteStream(filePath);
  const res = await drive.files.get({
    fileId: file.id,
    alt: 'media'
  }, { responseType: 'stream' });

  res.data.on('data', () => bar.increment(1)).pipe(dest);

  await new Promise((resolve, reject) => {
    dest.on('finish', () => { bar.stop(); resolve(); });
    dest.on('error', reject);
  });
  console.log(`[DOWNLOAD] Saved to: ${filePath}\n`);
  return filePath;
}

async function transcribe(filePath, fileName) {
  console.log(`[TRANSCRIBE] Transcribing: ${fileName}`);
  const transcriptPath = path.join(TRANSCRIPTS_DIR, fileName.replace('.mp4', '.txt'));
  const resp = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: 'whisper-1'
  });
  fs.writeFileSync(transcriptPath, resp.text);
  console.log(`[TRANSCRIBE] Transcript saved to: ${transcriptPath}\n`);
  return resp.text;
}

async function appendToSheet(auth, title, transcript, fileId) {
  console.log(`[LOG] Logging transcript to Google Sheet...`);
  const sheets = google.sheets({ version: 'v4', auth });
  const driveLink = `https://drive.google.com/file/d/${fileId}/view`;
  await sheets.spreadsheets.values.append({
    spreadsheetId: SPREADSHEET_ID,
    range: `${SHEET_NAME}!A:C`,
    valueInputOption: 'RAW',
    requestBody: {
      values: [[title, transcript, driveLink]]
    }
  });
  console.log(`[LOG] Entry added: ${title} | ${driveLink}\n`);
}

async function main() {
  console.log(`[INFO] Starting YouTube Shorts Organizer...`);
  const auth = await authenticateGoogleAPIs();
  console.log(`[INFO] Authenticating with Google Drive and Sheets...`);

  const files = await listDriveVideos(auth);
  if (!files.length) {
    console.log('[INFO] No new videos found.');
    return;
  }

  console.log(`[DOWNLOAD] Found ${files.length} new video(s) to download.`);

  for (const file of files) {
    const videoPath = await downloadVideo(auth, file);
    if (!videoPath) continue;

    const transcript = await transcribe(videoPath, file.name);
    await appendToSheet(auth, file.name, transcript, file.id);
  }

  console.log(`[SUCCESS] All videos processed successfully.`);
}

main().catch(err => console.error('[ERROR]', err));

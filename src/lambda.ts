import * as dotenv from 'dotenv';
import * as puppeteer from 'puppeteer-core';

const chromium = require('chrome-aws-lambda');

dotenv.config();

async function launchBrowser() {
  const isLambda = !!process.env.AWS_EXECUTION_ENV;

  const executablePath = isLambda
      ? await chromium.executablePath
      : '/Applications/Chromium.app/Contents/MacOS/Chromium';

  return await puppeteer.launch({
    args: isLambda
        ? chromium.args
        : ['--no-sandbox', '--disable-setuid-sandbox'],
    executablePath,
    headless: true,
    defaultViewport: isLambda
        ? chromium.defaultViewport
        : { width: 1280, height: 800 },
  });
}

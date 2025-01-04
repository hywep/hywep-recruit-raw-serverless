import * as dotenv from 'dotenv';
import * as puppeteer from 'puppeteer-core';
import {Page} from "puppeteer-core/lib/cjs/puppeteer/common/Page";

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

async function login(page: Page) {
  console.log('Starting login process...');

  page.on('dialog', async (dialog) => {
    await dialog.accept();
  });

  await page.goto('https://hywep.hanyang.ac.kr/index.do', {
    timeout: 30000,
    waitUntil: 'domcontentloaded',
  });

  await page.click('a[onclick="return topLogin(\'1\')"] .log_btn');

  await page.waitForSelector('#uid');
  await page.type('#uid', process.env.HYWE_LOGIN_USERNAME!);
  await page.type('#upw', process.env.HYWE_LOGIN_PASSWORD!);
  await page.click('#login_btn');

  const cookies = await page.cookies();
  return cookies.map(({name, value}) => ({name, value}));
}

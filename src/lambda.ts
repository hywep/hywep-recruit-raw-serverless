import {Callback, Context, Handler} from 'aws-lambda';
import * as dotenv from 'dotenv';
import * as puppeteer from 'puppeteer-core';
import {Page} from 'puppeteer-core';
import {sendMessageToSQS} from "./sqs";
import {uploadToS3} from "./s3";
import {fieldNames} from "./contants";
import {delay} from './utils'
import {datadog} from 'datadog-lambda-js';
import tracer from 'dd-trace';

const chromium = require('chrome-aws-lambda');

dotenv.config();
tracer.init();

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

async function getTotalPages(page: Page, cookies): Promise<number> {
  await page.goto('https://hywep.hanyang.ac.kr/compjoinsearch/list.do');
  await page.setCookie(...cookies);

  await page.reload();

  const totalText = await page.$eval(
      'span[style*="font-weight: 600;"]',
      (span) => span.textContent || '',
  );
  const match = totalText.match(/총\s*:\s*(\d+)\s*건/);

  if (!match || !match[1]) throw new Error('Could not extract total count.');

  const totalCount = parseInt(match[1], 10);
  return Math.ceil(totalCount / 50);
}

async function handlePopup(
    page: puppeteer.Page,
    jidSeq: string,
    rowData: Record<string, any>,
    pageNum: number,
    maxRetries: number = 10,
): Promise<Record<string, any>> {
  const browser = page.browser();
  let retries = 0;
  let pagesBefore: Page[];

  while (retries < maxRetries) {
    let newPopup: puppeteer.Page | null = null;

    try {
      pagesBefore = await browser.pages();

      const newPagePromise = new Promise<puppeteer.Page>((resolve, reject) => {
        const onTargetCreated = async (target: puppeteer.Target) => {
          try {
            const page = await target.page();
            if (page) {
              browser.off('targetcreated', onTargetCreated); // Detach listener
              resolve(page);
            }
          } catch (err) {
            reject(err);
          }
        };
        browser.on('targetcreated', onTargetCreated);
      });

      await page.evaluate((id) => {
        if (typeof (window as any).goView === 'function') {
          try {
            (window as any).goView(id);
          } catch (error) {
            console.error('Error executing goView:', error);
            throw error; // Propagate to retry mechanism
          }
        } else {
          throw new Error(
              'goView function is not defined in the page context.',
          );
        }
      }, jidSeq);

      newPopup = await Promise.race([
        newPagePromise,
        (async () => {
          await new Promise((resolve) => setTimeout(resolve, 1000)); // Allow time for popup
          const pagesAfter = await browser.pages();
          return pagesAfter.find((p) => !pagesBefore.includes(p)) || null;
        })(),
      ]);

      if (!newPopup) {
        console.error(
            `Popup not found for jidSeq: ${jidSeq} on page ${pageNum}`,
        );
        throw new Error('Popup not found.');
      }

      await newPopup.bringToFront();
      await newPopup.waitForSelector('table.write tr', { timeout: 5000 });

      const rowsInPopup = await newPopup.$$('table.write tr');
      if (rowsInPopup.length === 0) {
        console.warn(
            `Popup for jidSeq: ${jidSeq} on page ${pageNum} is blank. Retrying...`,
        );
        throw new Error('Popup is blank.');
      }

      for (const row of rowsInPopup) {
        const header = await row.$eval(
            'th',
            (th) => th.textContent?.trim() || '',
        );
        const value = await row.$eval(
            'td',
            (td) => td.textContent?.trim() || '',
        );
        rowData[header] = value;
      }

      console.log(
          `Popup data extracted for jidSeq: ${jidSeq} on page ${pageNum}`,
      );
      break;
    } catch (error) {
      retries += 1;
      console.error(
          `Error while handling popup for jidSeq: ${jidSeq} on page ${pageNum} (Attempt ${retries} of ${maxRetries}`,
          error,
      );

      if (retries >= maxRetries) {
        console.error(
            `Max retries reached for jidSeq: ${jidSeq} on page ${pageNum}`,
        );
        throw error;
      }

      const pagesAfter = await browser.pages();
      const extraPages = pagesAfter.filter((p) => !pagesBefore.includes(p));

      if (extraPages.length > 0) {
        console.log(
            `Detected ${extraPages.length} extra page(s). Closing them...`,
        );
        for (const page of extraPages) {
          try {
            console.log(`Closing page with URL: ${page.url()}`);
            await page.close();
          } catch (closeError) {
            console.error(
                `Failed to close extra page with URL: ${page.url()}`,
                closeError,
            );
          }
        }
      }
    } finally {
      if (newPopup) {
        try {
          await newPopup.close();
        } catch (closeError) {
          console.error(
              `Failed to close popup for jidSeq: ${jidSeq}`,
              closeError,
          );
        }
        newPopup = null;
      }
    }
  }

  return rowData;
}

async function processPage(page: Page, pageNum: number) {
  console.log(`Processing page ${pageNum}...`);

  await page.evaluate((num) => (window as any).Paging(num), pageNum);

  await delay(3000);

  const rows = await page.$$('table.list.grid_header tbody tr');

  console.log(`total rows ${rows.length}`);
  const pageData: any[] = [];

  for (const row of rows) {
    const rowData: Record<string, any> = {};
    const columns = await row.$$('td');

    try {
      for (let i = 0; i < columns.length; i++) {
        const text = await columns[i].evaluate(
            (td) => td.textContent?.trim() || '',
        );
        rowData[fieldNames[i]] = text;
      }

      const jidSeq = await row.$eval(
          'td:nth-child(3) a',
          (a) => (a.getAttribute('href')?.match(/goView\('([^']+)'\)/) || [])[1],
      );

      if (jidSeq) {
        rowData['id'] = jidSeq;

        try {
          await handlePopup(page, jidSeq, rowData, pageNum);
        } catch (popupError) {
          console.error(
              `Failed to process popup for jidSeq: ${jidSeq} on page ${pageNum}`,
              popupError,
          );
        }
      }

      pageData.push(rowData);
    } catch (rowError) {
      console.error(rowError);
    }
  }

  console.log(`Finished processing page ${pageNum}`);
  return pageData;
}

const crawlAndSaveData = async () => {
  console.log('Starting crawling...');

  const browser = await launchBrowser();

  try {
    const page = await browser.newPage();
    const cookies = await login(page);
    const totalPages = await getTotalPages(page, cookies);
    await page.close();

    const pageNumbers = Array.from({ length: totalPages }, (_, i) => i);
    console.log(`Pages to process: ${pageNumbers}`);

    const results = [];

    for (const pageNum of pageNumbers) {
      const page = await browser.newPage();

      try {
        await page.goto('https://hywep.hanyang.ac.kr/compjoinsearch/list.do', {
          waitUntil: 'networkidle2',
        });

        await page.setCookie(...cookies);
        await page.reload({ waitUntil: 'networkidle2' });

        const pageData = await processPage(page, pageNum);
        results.push(...pageData);
      } catch (error) {
        console.error(`Error processing page ${pageNum}:`, error);
      } finally {
        await page.close();
      }
    }

    console.log('Processing complete.');

    const bucketName = process.env.HYWE_RECRUIT_BUCKET_NAME!;
    const timestamp = new Date().toISOString();
    const key = `raw-data-${timestamp}.json`;
    const body = JSON.stringify(results, null, 2);

    await uploadToS3(bucketName, key, body);

    const metadata = {
      bucketName,
      key,
      totalPages,
      itemCount: results.length,
      timestamp,
    };

    await sendMessageToSQS(metadata);
  } catch (error) {
    console.error('Error during crawling:', error);
  } finally {
    await browser.close();
  }
};

export const rawHandler: Handler = async (
    event: any,
    context: Context,
    callback: Callback,
) => {
  console.log('Incoming Event:', JSON.stringify(event, null, 2));
  await crawlAndSaveData();
};

export const handler = datadog(rawHandler);

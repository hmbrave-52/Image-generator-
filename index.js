const express = require('express');
const puppeteer = require('puppeteer');
const { Groq } = require('groq-sdk');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// --- DYNAMIC GROQ KEY ROTATOR ---
let groqKeys = [];
try {
  groqKeys = JSON.parse(process.env.GROQ_KEYS_JSON || '[]');
} catch (e) {
  console.error('[Groq Manager] Error parsing GROQ_KEYS_JSON.');
}

if (groqKeys.length === 0 && process.env.GROQ_API_KEY) {
  groqKeys.push(process.env.GROQ_API_KEY);
}

console.log(`[Groq Manager] Successfully loaded ${groqKeys.length} API keys into rotation pool.`);

let currentKeyIndex = 0;

function getGroqClient() {
  if (groqKeys.length === 0) {
    throw new Error('No Groq API keys found in environment variables.');
  }
  return new Groq({ apiKey: groqKeys[currentKeyIndex] });
}

async function callGroqWithRotation(messages, options = {}) {
  let attempts = 0;
  while (attempts < groqKeys.length) {
    try {
      const groq = getGroqClient();
      const response = await groq.chat.completions.create({
        model: 'qwen/qwen3.8-27b',
        messages: messages,
        temperature: options.temperature || 0.1,
        max_completion_tokens: options.max_tokens || 512,
      });
      return response.choices[0]?.message?.content || '';
    } catch (error) {
      if (error.status === 429 || error.status === 401) {
        console.warn(`[Groq Rotator] Key index ${currentKeyIndex} hit rate limit or auth error. Rotating key...`);
        currentKeyIndex = (currentKeyIndex + 1) % groqKeys.length;
        attempts++;
      } else {
        throw error;
      }
    }
  }
  throw new Error('All Groq API keys have been exhausted or hit rate limits.');
}

app.get('/', (req, res) => {
  res.send('Luna Google Flow Bridge Server with Vision Diagnostics is active.');
});

app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }

  console.log(`[Google Flow] Processing request for prompt: "${prompt}"`);
  let browser;
  let currentStep = 'Initialization';

  try {
    // Standard headless mode matching downloaded Chrome binary
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-accelerated-2d-canvas',
        '--disable-gpu'
      ]
    });

    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });
    await page.setUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/127.0.0.0 Safari/537.36');

    // LOG CAPTURE: Forward page console messages & JS errors straight to Render logs
    page.on('console', msg => console.log(`[Browser Console]: ${msg.text()}`));
    page.on('pageerror', err => console.error(`[Browser Page Error]: ${err.message}`));

    if (!process.env.GOOGLE_COOKIES_JSON) {
      throw new Error('Security Error: GOOGLE_COOKIES_JSON environment variable is missing.');
    }

    const rawCookies = JSON.parse(process.env.GOOGLE_COOKIES_JSON);
    const sanitizedCookies = rawCookies.map(cookie => {
      const cleanCookie = { ...cookie };
      if (!cleanCookie.partitionKey || cleanCookie.partitionKey === null) delete cleanCookie.partitionKey;
      if (cleanCookie.storeId === null) delete cleanCookie.storeId;
      if (cleanCookie.firstPartyDomain === "") delete cleanCookie.firstPartyDomain;
      if (cleanCookie.sameSite === null) delete cleanCookie.sameSite;
      return cleanCookie;
    });

    await page.setCookie(...sanitizedCookies);
    console.log('[Google Flow] Loaded session cookies.');

    // STEP 1: Open Google Flow
    currentStep = 'Opening flow.google.com';
    console.log(`[Google Flow] Step 1: ${currentStep}...`);
    await page.goto('https://flow.google.com', { waitUntil: 'networkidle2', timeout: 60000 });

    // STEP 2: Check workspace status
    currentStep = 'Checking workspace / New Project';
    console.log(`[Google Flow] Step 2: ${currentStep}...`);
    await new Promise(r => setTimeout(r, 4000));
    
    const isInputPresent = await page.evaluate(() => {
      return !!document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
    });

    if (!isInputPresent) {
      console.log('[Google Flow] Prompt box not active directly, clicking New Project...');
      await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, [role="button"], div'));
        const target = buttons.find(b => {
          const text = b.innerText?.trim().toLowerCase() || '';
          const aria = b.getAttribute('aria-label')?.toLowerCase() || '';
          return text.includes('new') || text.includes('create') || text.includes('+') || aria.includes('new') || aria.includes('create');
        });
        if (target) target.click();
      });
      await new Promise(r => setTimeout(r, 4000));
    }

    // STEP 3: Enter prompt
    currentStep = 'Entering prompt into input box';
    console.log(`[Google Flow] Step 3: ${currentStep}...`);
    const inputSelector = 'textarea, input[type="text"], [contenteditable="true"]';
    
    await page.waitForSelector(inputSelector, { timeout: 20000 });
    
    await page.evaluate((userPrompt) => {
      const input = document.querySelector('textarea, input[type="text"], [contenteditable="true"]');
      if (input) {
        input.focus();
        if (input.tagName === 'INPUT' || input.tagName === 'TEXTAREA') {
          input.value = userPrompt;
          input.dispatchEvent(new Event('input', { bubbles: true }));
          input.dispatchEvent(new Event('change', { bubbles: true }));
        } else {
          input.innerText = userPrompt;
          input.dispatchEvent(new InputEvent('input', { bubbles: true }));
        }
      }
    }, prompt);

    console.log('[Google Flow] Prompt entered successfully.');
    await new Promise(r => setTimeout(r, 1000));

    // STEP 4: Trigger generation
    currentStep = 'Triggering generation button click';
    console.log(`[Google Flow] Step 4: ${currentStep}...`);
    
    const clicked = await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('button, [role="button"], div, span'));
      const genBtn = elements.find(el => {
        const text = el.innerText?.trim().toLowerCase() || '';
        const aria = el.getAttribute('aria-label')?.toLowerCase() || '';
        const testId = el.getAttribute('data-testid')?.toLowerCase() || '';
        
        return text.includes('generate') || 
               text.includes('create') || 
               text.includes('run') ||
               aria.includes('generate') || 
               aria.includes('create') || 
               aria.includes('send') ||
               aria.includes('submit') ||
               testId.includes('submit') ||
               testId.includes('generate');
      });

      if (genBtn) {
        genBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      console.log('[Google Flow] Submit button missed. Pressing Enter as fallback...');
      await page.keyboard.press('Enter');
    }

    console.log('[Google Flow] Generation triggered. Activating network interceptor...');

    // NETWORK INTERCEPTOR
    let interceptedImageUrl = null;
    page.on('response', async (response) => {
      try {
        const url = response.url();
        if (url.includes('=s32') || url.includes('=s64') || url.includes('avatar') || url.includes('favicon') || url.includes('logo')) return;

        if ((url.includes('googleusercontent.com') || url.includes('gen_img') || url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.webp')) && !url.includes('favicon')) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('image') || url.includes('googleusercontent.com')) {
            if (!interceptedImageUrl) {
              interceptedImageUrl = url;
              console.log('[Google Flow] Intercepted generated image URL:', url);
            }
          }
        }
      } catch (e) {}
    });

    // STEP 5: Wait for image result
    currentStep = 'Waiting for image rendering/network stream';
    console.log(`[Google Flow] Step 5: ${currentStep} (up to 120s)...`);
    
    const startTime = Date.now();
    while (Date.now() - startTime < 120000) {
      if (interceptedImageUrl) break;

      const domImgUrl = await page.evaluate(() => {
        const imgs = document.querySelectorAll('img');
        for (const img of imgs) {
          const src = img.src || '';
          if (src && !src.includes('avatar') && !src.includes('favicon') && !src.includes('=s32') && (img.naturalWidth > 200 || src.includes('googleusercontent'))) {
            return src;
          }
        }
        return null;
      });

      if (domImgUrl) {
        interceptedImageUrl = domImgUrl;
        break;
      }

      await new Promise(r => setTimeout(r, 3000));
    }

    if (!interceptedImageUrl) {
      throw new Error(`Timed out at step: "${currentStep}". Image URL was not captured.`);
    }

    await browser.close();
    console.log('[Google Flow] Success! Real image URL retrieved.');
    return res.json({ success: true, imageUrl: interceptedImageUrl });

  } catch (error) {
    console.error(`[Google Flow Error during "${currentStep}"]:`, error.message);
    
    let aiReason = 'Could not generate AI vision diagnostic.';
    if (browser && groqKeys.length > 0) {
      try {
        const pages = await browser.pages();
        if (pages.length > 0) {
          const page = pages[0];
          console.log('[AI Diagnostics] Capturing browser screenshot for Qwen 3.8 Vision analysis...');
          const screenshotBase64 = await page.screenshot({ encoding: 'base64', fullPage: true });

          aiReason = await callGroqWithRotation([
            {
              role: 'system',
              content: 'You are an expert web automation debugging agent with vision capabilities. Analyze this screenshot of the Google Flow interface. Identify any visual errors, popups, blank spaces, stuck loading states, or reasons why image generation did not finish.'
            },
            {
              role: 'user',
              content: [
                { type: 'text', text: `Failed Step: ${currentStep}\nError: ${error.message}` },
                {
                  type: 'image_url',
                  image_url: { url: `data:image/png;base64,${screenshotBase64}` }
                }
              ]
            }
          ], { max_tokens: 350 });
          
          console.log('\n================ QWEN VISION DIAGNOSTIC REPORT ================\n');
          console.log(aiReason);
          console.log('\n================================================================\n');
        }
      } catch (diagErr) {
        aiReason = 'Vision diagnostic capture failed: ' + diagErr.message;
      }
    }

    if (browser) await browser.close();
    return res.status(500).json({ 
      success: false, 
      error: error.message, 
      failedStep: currentStep,
      aiDiagnosticReport: aiReason 
    });
  }
});

app.listen(PORT, () => {
  console.log(`[Luna Server] Listening on port ${PORT}`);
});
      

const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
app.use(express.json());

const PORT = process.env.PORT || 10000;

// Health check endpoint for GET requests
app.get('/', (req, res) => {
  res.send('Luna Google Flow Bridge Server is active.');
});

app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;
  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Prompt is required' });
  }

  console.log(`[Google Flow] Processing request for prompt: "${prompt}"`);
  let browser;
  try {
    // Launch Puppeteer in headless mode with Render-compatible flags
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

    // SAFETY CHECK: Load cookies strictly from Render private environment variable
    if (!process.env.GOOGLE_COOKIES_JSON) {
      throw new Error('Security Error: GOOGLE_COOKIES_JSON environment variable is missing.');
    }

    const rawCookies = JSON.parse(process.env.GOOGLE_COOKIES_JSON);

    // Clean cookies to remove null partitionKeys and incompatible attributes
    const sanitizedCookies = rawCookies.map(cookie => {
      const cleanCookie = { ...cookie };
      if (!cleanCookie.partitionKey || cleanCookie.partitionKey === null) {
        delete cleanCookie.partitionKey;
      }
      if (cleanCookie.storeId === null) delete cleanCookie.storeId;
      if (cleanCookie.firstPartyDomain === "") delete cleanCookie.firstPartyDomain;
      if (cleanCookie.sameSite === null) delete cleanCookie.sameSite;
      return cleanCookie;
    });

    await page.setCookie(...sanitizedCookies);
    console.log('[Google Flow] Successfully loaded secure session cookies.');

    // STEP 1: Open Google Flow
    console.log('[Google Flow] Opening flow.google.com...');
    await page.goto('https://flow.google.com', { waitUntil: 'networkidle2', timeout: 60000 });

    // STEP 2: Click "+ New" or create project button
    console.log('[Google Flow] Checking for New Project / Create button...');
    await page.waitForSelector('button, [role="button"]', { timeout: 15000 });
    
    const newProjectClicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"], div'));
      const target = buttons.find(b => {
        const text = b.innerText?.trim().toLowerCase() || '';
        const aria = b.getAttribute('aria-label')?.toLowerCase() || '';
        return text.includes('new') || text.includes('create') || text.includes('+') || aria.includes('new') || aria.includes('create');
      });
      if (target) {
        target.click();
        return true;
      }
      return false;
    });

    if (!newProjectClicked) {
      throw new Error('Could not find New Project / Create button.');
    }

    console.log('[Google Flow] Clicked "New Project" successfully. Waiting for workspace...');
    await new Promise(r => setTimeout(r, 4000));

    // STEP 3: Select model (Nano Banana 2.1 / Pro fallback)
    console.log('[Google Flow] Selecting model: Nano Banana 2.1 (Fallback: Nano Banana Pro)...');
    await page.evaluate(() => {
      const elements = Array.from(document.querySelectorAll('*'));
      const modelEl = elements.find(el => el.innerText && (el.innerText.includes('Nano Banana') || el.innerText.includes('Model')));
      if (modelEl) modelEl.click();
    });
    await new Promise(r => setTimeout(r, 2000));

    // STEP 4: Enter prompt into text area/box
    console.log('[Google Flow] Entering prompt...');
    const inputSelector = 'textarea, input[type="text"], [contenteditable="true"]';
    await page.waitForSelector(inputSelector, { timeout: 15000 });
    
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

    console.log('[Google Flow] Prompt entered into box.');
    await new Promise(r => setTimeout(r, 1000));

    // STEP 5: Trigger generation (Click button or fallback to Enter key)
    console.log('[Google Flow] Triggering generation...');
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
      console.log('[Google Flow] Submit button icon not found directly, pressing Enter key...');
      await page.keyboard.press('Enter');
    }

    console.log('[Google Flow] Generation triggered. Activating network interceptor for final render...');

    // NETWORK INTERCEPTOR: Started AFTER generation so it ignores profile avatars entirely
    let interceptedImageUrl = null;
    page.on('response', async (response) => {
      try {
        const url = response.url();
        // Ignore account icons, profile pictures, and small thumbnails (=s32, =s64, avatars)
        if (url.includes('=s32') || url.includes('=s64') || url.includes('avatar') || url.includes('favicon') || url.includes('logo')) {
          return;
        }

        if ((url.includes('googleusercontent.com') || url.includes('gen_img') || url.endsWith('.png') || url.endsWith('.jpg') || url.endsWith('.webp')) &&
            !url.includes('favicon')) {
          const contentType = response.headers()['content-type'] || '';
          if (contentType.includes('image') || url.includes('googleusercontent.com')) {
            if (!interceptedImageUrl) {
              interceptedImageUrl = url;
              console.log('[Google Flow] Intercepted real generated image URL:', url);
            }
          }
        }
      } catch (e) {}
    });

    // STEP 6: Wait for the network interceptor or DOM to catch the actual generated image (up to 150s)
    const startTime = Date.now();
    while (Date.now() - startTime < 150000) {
      if (interceptedImageUrl) {
        break;
      }

      // Fallback DOM check for large images only
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

    await browser.close();

    if (!interceptedImageUrl) {
      throw new Error('Image generation timed out or image URL could not be captured.');
    }

    console.log('[Google Flow] Success! Real image URL retrieved.');
    return res.json({ success: true, imageUrl: interceptedImageUrl });

  } catch (error) {
    if (browser) await browser.close();
    console.error('[Google Flow Error]:', error.message);
    return res.status(500).json({ success: false, error: error.message });
  }
});

app.listen(PORT, () => {
  console.log(`[Luna Server] Listening on port ${PORT}`);
});
      

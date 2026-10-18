const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// Enable CORS for Luna AI Web App frontend calls
app.use(cors({
  origin: '*', 
  methods: ['GET', 'POST']
}));

app.use(express.json());

// SAFETY CHECK: Warn immediately on startup if cookies are missing from environment variables
if (!process.env.GOOGLE_COOKIES_JSON) {
  console.warn('[SECURITY WARNING] GOOGLE_COOKIES_JSON is missing! Ensure it is set securely in your Render Environment Variables.');
}

/**
 * Automates Google Flow securely using environment-injected cookies:
 * - Auto-clicks new project
 * - Selects Nano Banana 2.1 (falls back to Pro on error)
 * - Types prompt and retrieves image
 */
async function generateImageViaGoogleFlow(promptText) {
  console.log(`[Google Flow] Processing request for prompt: "${promptText}"`);
  
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-setuid-sandbox',
      '--disable-dev-shm-usage',
      '--disable-accelerated-2d-canvas',
      '--no-first-run',
      '--no-zygote',
      '--disable-gpu'
    ]
  });

  try {
    const page = await browser.newPage();
    await page.setViewport({ width: 1280, height: 800 });

    // SAFETY CHECK: Load cookies strictly from Render private environment variable
    if (!process.env.GOOGLE_COOKIES_JSON) {
      throw new Error('Security Error: GOOGLE_COOKIES_JSON environment variable is missing.');
    }
    
    const cookies = JSON.parse(process.env.GOOGLE_COOKIES_JSON);
    await page.setCookie(...cookies);
    console.log('[Google Flow] Successfully loaded secure session cookies.');

    // Navigate to Google Flow
    console.log('[Google Flow] Opening flow.google.com...');
    await page.goto('https://flow.google.com/', {
      waitUntil: 'networkidle2',
      timeout: 60000
    });

    // STEP 1: Auto-click "+ New" or "Create project" if landing on the front page dashboard
    console.log('[Google Flow] Checking for New Project / Create button...');
    try {
      const createButtonClicked = await page.evaluate(() => {
        const elements = Array.from(document.querySelectorAll('button, div, span'));
        const createBtn = elements.find(el => {
          const text = el.innerText?.trim().toLowerCase();
          return text === '+ new' || text === 'new project' || text === 'create project' || text === '+ create';
        });
        
        if (createBtn) {
          createBtn.click();
          return true;
        }
        return false;
      });

      if (createButtonClicked) {
        console.log('[Google Flow] Clicked "New Project" successfully. Waiting for workspace...');
        await new Promise(r => setTimeout(r, 4000));
      } else {
        console.log('[Google Flow] Already inside a project or button not found. Proceeding...');
      }
    } catch (e) {
      console.log('[Google Flow] Skipping project creation step.');
    }

    // STEP 2: Select "Nano Banana 2.1" model (with automatic fallback to "Nano Banana Pro")
    console.log('[Google Flow] Selecting model: Nano Banana 2.1 (Fallback: Nano Banana Pro)...');
    try {
      const modelMenuOpened = await page.evaluate(() => {
        const buttons = Array.from(document.querySelectorAll('button, div[role="button"], span'));
        const dropdownBtn = buttons.find(b => {
          const text = b.innerText?.toLowerCase() || '';
          return text.includes('banana') || text.includes('model') || text.includes('imagen') || b.querySelector('svg');
        });
        if (dropdownBtn) {
          dropdownBtn.click();
          return true;
        }
        return false;
      });

      if (modelMenuOpened) {
        await new Promise(r => setTimeout(r, 1500));
        
        await page.evaluate(() => {
          const items = Array.from(document.querySelectorAll('div, span, button, li, option'));
          
          const target21 = items.find(el => el.innerText?.trim().toLowerCase().includes('nano banana 2.1'));
          if (target21) {
            target21.click();
            console.log('Selected Nano Banana 2.1');
          } else {
            const targetPro = items.find(el => el.innerText?.trim().toLowerCase().includes('nano banana pro'));
            if (targetPro) {
              targetPro.click();
              console.log('Fallback to Nano Banana Pro selected');
            }
          }
        });
        await new Promise(r => setTimeout(r, 1500));
      }
    } catch (modelErr) {
      console.warn('[Google Flow] Model selection warning (proceeding with default):', modelErr.message);
    }

    // STEP 3: Find prompt text box and type prompt
    const promptSelector = 'textarea, input[placeholder*="prompt" i], input[type="text"]';
    await page.waitForSelector(promptSelector, { timeout: 30000 });
    
    await page.type(promptSelector, promptText, { delay: 30 });
    console.log('[Google Flow] Prompt entered into box.');

    // STEP 4: Click the Generate button
    const clicked = await page.evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button'));
      const genBtn = buttons.find(b => 
        b.innerText.toLowerCase().includes('generate') || 
        b.getAttribute('aria-label')?.toLowerCase().includes('generate')
      );
      if (genBtn) {
        genBtn.click();
        return true;
      }
      return false;
    });

    if (!clicked) {
      throw new Error('Generate button could not be located in Google Flow DOM.');
    }

    console.log('[Google Flow] Generation triggered. Waiting for image result...');

    // STEP 5: Wait for resulting image to render
    const imgSelector = 'img[src*="blob:"], img[src*="googleusercontent"], img[alt*="generated" i]';
    await page.waitForSelector(imgSelector, { timeout: 90000 });

    const imageUrl = await page.$eval(imgSelector, img => img.src);
    console.log('[Google Flow] Image successfully retrieved!');

    await browser.close();
    return imageUrl;

  } catch (error) {
    await browser.close();
    console.error('[Google Flow Error]:', error.message);
    throw new Error(`Google Flow Automation Failed: ${error.message}`);
  }
}

/**
 * Luna Web AI Request Endpoint
 * POST /api/generate-image
 * Body: { "prompt": "cybernetic arctic fox" }
 */
app.post('/api/generate-image', async (req, res) => {
  const { prompt } = req.body;

  if (!prompt) {
    return res.status(400).json({ success: false, error: 'Missing "prompt" parameter in request body.' });
  }

  try {
    const imageUrl = await generateImageViaGoogleFlow(prompt);
    
    res.json({
      success: true,
      prompt,
      imageUrl
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message
    });
  }
});

// Server status & wake-up endpoint
app.get('/', (req, res) => {
  res.send('Luna Google Flow Bridge Server is active.');
});

app.listen(PORT, () => {
  console.log(`[Luna Server] Listening on port ${PORT}`);
});
  

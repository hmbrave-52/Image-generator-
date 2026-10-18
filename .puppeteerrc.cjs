const { join } = require('path');

/**
 * @type {import("puppeteer").Configuration}
 */
module.exports = {
  // Save Chrome inside project directory so Render keeps it
  cacheDirectory: join(__dirname, '.cache', 'puppeteer'),
};

#!/usr/bin/env bash
# Exit on error
set -o errexit

# Install npm dependencies
npm install

# Download Chrome executable for Puppeteer on Render Linux environment
npx puppeteer browsers install chrome

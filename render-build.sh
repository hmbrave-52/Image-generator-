#!/usr/bin/env bash
# Exit on error
set -o errexit

# Install Node dependencies
npm install

# Download and install the exact Chrome version Puppeteer needs
npx puppeteer browsers install chrome

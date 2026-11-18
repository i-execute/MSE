'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const h = require('./lib/harness.js');

test('Image downscaling: canvas downscales to jpeg and limits excessive image payload', { timeout: 60000 }, async () => {
  const t = await h.launch({ api: () => ({ status: 200, json: [] }) });
  try {
    const page = await t.newPage(h.fixtureUrl('attempt'));
    await page.waitForFunction(() => !!window.__mse);

    // Test 1: Canvas downscales large image to JPEG
    await page.evaluate(() => {
      // Create a large 2000x2000 test image via canvas
      const cvs = document.createElement('canvas');
      cvs.width = 2000;
      cvs.height = 1500;
      const ctx = cvs.getContext('2d');
      ctx.fillStyle = '#ff0000';
      ctx.fillRect(0, 0, 2000, 1500);
      const largeDataUrl = cvs.toDataURL('image/png');

      const img = document.createElement('img');
      img.id = 'large-test-image';
      img.src = largeDataUrl;
      document.querySelector('.que .qtext').appendChild(img);

      window.MSEBridge.url = () => location.origin;
      window.MSEBridge.agent = async payload => {
        window.__capturedPayload = payload;
        return { ok: true, answer: '1:М' };
      };
      window.__mse.open();
    });

    await page.waitForFunction(() => !!window.__mse.state().question);
    await page.evaluate(() => window.__mse.runAgent());

    await page.waitForFunction(() => !!window.__capturedPayload);
    const captured = await page.evaluate(() => window.__capturedPayload);
    assert.ok(captured.image && captured.image.length > 0, 'Image is attached in payload');
    assert.match(captured.image[0].data, /^data:image\/jpeg;base64,/, 'Large image was downscaled to JPEG format');

    // Test 2: Over 1.5MB image total raises informative refusal without crashing
    await page.evaluate(() => {
      window.__capturedPayload = null;
      // Add multiple massive images that exceed 1.5MB limit
      const qtext = document.querySelector('.que .qtext');
      qtext.innerHTML = '';
      for (let i = 0; i < 4; i++) {
        const cvs = document.createElement('canvas');
        cvs.width = 1024;
        cvs.height = 1024;
        const ctx = cvs.getContext('2d');
        // generate noise to prevent jpeg compression from making it tiny
        const idata = ctx.createImageData(1024, 1024);
        for (let j = 0; j < idata.data.length; j += 4) {
          idata.data[j] = (Math.random() * 255) | 0;
          idata.data[j + 1] = (Math.random() * 255) | 0;
          idata.data[j + 2] = (Math.random() * 255) | 0;
          idata.data[j + 3] = 255;
        }
        ctx.putImageData(idata, 0, 0);
        const img = document.createElement('img');
        img.src = cvs.toDataURL('image/jpeg', 0.95);
        qtext.appendChild(img);
      }
      window.__mse.runAgent();
    });

    await page.waitForFunction(() => {
      const ag = window.__mse.agent();
      return ag && ag.state === 'error';
    });
    const errText = await page.evaluate(() => window.__mse.agent().text);
    assert.match(errText, /too large|1\.5MB/i, 'Informative error text when images exceed limit');
  } finally {
    await t.close();
  }
});

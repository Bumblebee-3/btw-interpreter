const BrowserController = require('./plugins/browser/index');
(async () => {
  const browser = new BrowserController();
  await browser.init(false);

  await browser.openPage('https://www.reliancedigital.in/product/lenovo-yoga-7-2-in-1-14akp10-83jr009ein-standard-laptop-amd-ryzen-ai-7-35032-gb1tb-ssdintegrated-amd-radeon-860m-graphicswindows-11-homeoffice-home-2024-lenovo-ai-nowwuxga-3556-cm-14-inch-seashell-mi5ys3-9587663');
  await browser.type('textarea[name="q"]', 'playwright firefox');
  await browser.scroll(800);

  const links = await browser.getPageLinks();
  console.log(links.slice(0, 5));

  const buttons = await browser.getPageButtons();
  console.log(buttons.slice(0, 5));

  await browser.close();
})();
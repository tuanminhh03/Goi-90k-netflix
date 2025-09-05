import puppeteer from "puppeteer";

export const launchBrowser = async () => {
  return puppeteer.launch({
    headless: false, // false để thấy trình duyệt; true để chạy ngầm
    args: ["--no-sandbox", "--disable-setuid-sandbox"],
    defaultViewport: null,
  });
};

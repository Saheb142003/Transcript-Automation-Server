// server.js
import express from "express";
import helmet from "helmet";
import rateLimit from "express-rate-limit";
import cors from "cors";
import puppeteer from "puppeteer";
import dotenv from "dotenv";
import morgan from "morgan";

dotenv.config();
const app = express();
app.set("trust proxy", 1);
const PORT = process.env.PORT || 8000;

// ---------- SECURITY MIDDLEWARES ----------
app.use(helmet());

const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(",") || [];
app.use(
  cors({
    origin: (origin, callback) => {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
  })
);

const limiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  message: { ok: false, error: "Too many requests. Please try again later." },
});
app.use("/api/", limiter);

app.use(morgan("combined"));
app.use(express.json({ limit: "10kb" }));

// ---------- API KEY MIDDLEWARE ----------
app.use("/api/", (req, res, next) => {
  const apiKey = req.headers["x-api-key"];
  if (process.env.API_KEY && apiKey !== process.env.API_KEY) {
    return res
      .status(401)
      .json({ ok: false, error: "Unauthorized: Invalid API key" });
  }
  next();
});

// ---------- API ENDPOINT ----------
app.get("/api/transcript", async (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ ok: false, error: "Missing URL parameter" });
  }

  try {
    const transcript = await getTranscript(videoUrl);
    return res.json({ ok: true, transcript });
  } catch (error) {
    console.error(error);
    return res.status(500).json({ ok: false, error: error.message });
  }
});

// ---------- PUPPETEER FUNCTION ----------
async function getTranscript(videoUrl) {
  const browser = await puppeteer.launch({
    headless: true,
    args: [
      "--no-sandbox",
      "--disable-setuid-sandbox",
      "--disable-dev-shm-usage",
      "--disable-accelerated-2d-canvas",
      "--no-first-run",
      "--no-zygote",
      "--single-process",
      "--disable-gpu",
    ],
    executablePath: process.env.CHROMIUM_PATH || undefined, // <--- key line
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/135.0.0.0 Safari/537.36"
    );
    await page.goto(videoUrl, { waitUntil: "networkidle2" });

    let transcriptOpened = false;
    const buttons = await page.$$("ytd-button-renderer yt-button-shape button");

    for (let btn of buttons) {
      const text = await page.evaluate((el) => el.innerText.trim(), btn);
      if (text.toLowerCase().includes("transcript")) {
        await btn.evaluate((el) => el.scrollIntoView());
        await page.evaluate((el) => el.click(), btn);
        transcriptOpened = true;
        break;
      }
    }

    if (!transcriptOpened) {
      throw new Error(
        "❌ 'Show transcript' not found or disabled for this video."
      );
    }

    await page.waitForSelector("#segments-container", { timeout: 20000 });
    await autoScrollTranscript(page);

    const transcript = await page.evaluate(() => {
      return Array.from(
        document.querySelectorAll(
          "#segments-container ytd-transcript-segment-renderer .segment-text"
        )
      ).map((line) => line.innerText.trim());
    });

    return transcript;
  } finally {
    await browser.close();
  }
}

// ---------- SCROLL FUNCTION ----------
async function autoScrollTranscript(page) {
  await page.evaluate(async () => {
    const panel = document.querySelector("#segments-container");
    if (!panel) return;

    let lastCount = 0;
    let sameCount = 0;

    while (sameCount < 3) {
      panel.scrollTo(0, panel.scrollHeight);
      await new Promise((r) => setTimeout(r, 1500));
      const lines = document.querySelectorAll(
        "#segments-container ytd-transcript-segment-renderer"
      ).length;
      if (lines === lastCount) sameCount++;
      else {
        lastCount = lines;
        sameCount = 0;
      }
    }
  });
}

// ---------- START SERVER ----------
app.listen(PORT, () => {
  console.log(`✅ Transcript API server running on http://localhost:${PORT}`);
});

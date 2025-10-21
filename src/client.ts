import axios from "axios";
import fs from "fs/promises"; // Needed if you were reading locally, but not for this version
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";

// --- AI/API Configuration ---
// (We keep the AI config here as the client is the "brain")
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });

// --- Agent Server Configuration ---
const agentApi = "http://localhost:3000";
const targetUrl =
  "https://vmmv-uat.luxottica.com/v/5.5.2/demo/demo.html?key=95702A5E-1523-4ADD-AC16-5CE7062F7E32";
const traceDuration = 15000; // 15 seconds

// --- 1. API HELPER (To handle 503 errors) ---
// (This is now used by the analysis controller on the server,
// but we'll keep it here in case the client needs direct AI calls later)
async function makeApiCall(prompt: string) {
  let attempts = 0;
  const maxRetries = 3;
  while (attempts < maxRetries) {
    try {
      const result = await model.generateContent(prompt);
      return result;
    } catch (error: any) {
      if (
        error.status === 503 ||
        (error.message && error.message.includes("503"))
      ) {
        attempts++;
        const delay = Math.pow(2, attempts) * 1000;
        console.warn(
          `API is overloaded (503). Retrying in ${delay / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        throw error;
      }
    }
  }
  throw new Error("API call failed after multiple retries.");
}

// --- 2. MAIN WORKFLOW (Ties it all together) ---
async function runAnalysisFlow() {
  try {
    // 1. Tell server to START trace
    console.log(`[CLIENT]: Telling agent to start trace for: ${targetUrl}`);
    await axios.post(`${agentApi}/trace/start`, { url: targetUrl });
    console.log(`[CLIENT]: Trace started. Waiting ${traceDuration / 1000}s...`);

    // 2. Wait for trace to run
    await new Promise((resolve) => setTimeout(resolve, traceDuration));

    // 3. Tell server to STOP trace
    console.log(`[CLIENT]: Telling agent to stop trace...`);
    const stopResponse = await axios.post(`${agentApi}/trace/stop`);
    console.log(`[CLIENT]: Agent responded: ${stopResponse.data.message}`);

    // --- ANALYSIS STEP ---
    // 4. Send ANALYZE command (Using POST)
    console.log(`[CLIENT]: Asking agent to analyze the trace...`);
    const analysisResponse = await axios.post(`${agentApi}/trace/analyze`); // <-- UPDATED

    // 5. Print the final report
    console.log("\n--- ANALYSIS COMPLETE ---");
    console.log(analysisResponse.data.report); // <-- UPDATED to access .report
    // -------------------------
  } catch (error: any) {
    console.error(
      "[CLIENT]: Error running analysis flow:",
      error.response ? error.response.data : error.message
    );
  }
}

runAnalysisFlow();

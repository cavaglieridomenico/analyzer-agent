// analysis-controller.ts
import fs from "fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";
import { findWorstBottleneck } from "./utils/trace-analyzer";

// --- AI/API Configuration ---
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
//const model = genAI.getGenerativeModel({ model: "gemini-2.5-pro" });
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

// --- 1. API HELPER (To handle 503 errors and timeouts) ---
async function makeApiCall(prompt: string) {
  let attempts = 0;
  const maxRetries = 3;
  const timeout = 30000; // 30 seconds

  while (attempts < maxRetries) {
    try {
      const result = await Promise.race([
        model.generateContent(prompt),
        new Promise((_, reject) =>
          setTimeout(() => reject(new Error("API call timed out")), timeout)
        ),
      ]);
      // The type assertion is needed because Promise.race returns a generic Promise
      return result as Awaited<ReturnType<typeof model.generateContent>>;
    } catch (error: any) {
      if (
        error.message === "API call timed out" ||
        error.status === 503 ||
        (error.message && error.message.includes("503"))
      ) {
        attempts++;
        const delay = Math.pow(2, attempts) * 1000;
        console.warn(
          `API call failed (${error.message}). Retrying in ${delay / 1000}s...`
        );
        await new Promise((resolve) => setTimeout(resolve, delay));
      } else {
        console.error("A non-retryable API error occurred:", error);
        throw error;
      }
    }
  }
  const finalError = new Error("API call failed after multiple retries.");
  console.error(finalError.message);
  throw finalError;
}

// --- 3. AI ANALYZER (Sends bottleneck to Gemini) ---
async function getAnalysis(bottleneck: any) {
  console.log("[SERVER]: Sending bottleneck to Gemini for expert analysis...");
  const prompt = `
    You are an expert web performance analyst. I have captured a performance trace and
    identified the single worst bottleneck, including its direct child events.

    Analyze the following JSON object which describes this task:
    ${JSON.stringify(bottleneck, null, 2)}

    Provide a report in markdown format with the following sections:
    1.  **Root Cause Analysis:** Based on the main task (eventName: "${
      bottleneck.eventName
    }") and the context from its 'childEvents', what is the specific cause of this ${
    bottleneck.duration_ms
  }ms bottleneck?
    2.  **Actionable Solution:** Provide a specific code improvement or strategy to fix this. Reference the child events in your explanation.
    `;

  const result = await makeApiCall(prompt);
  return result.response.text();
}

// --- 4. MAIN FUNCTION (Ties it all together) ---
/**
 * Reads the trace file, finds the worst bottleneck,
 * and sends it to Gemini for analysis.
 */
export async function analyzeTraceFile(): Promise<string> {
  // 1. Read the trace file
  console.log("[SERVER]: Reading trace.json file...");
  const traceFile = await fs.readFile("trace.json", "utf8");
  const traceData = JSON.parse(traceFile);

  // 2. Find the worst bottleneck LOCALLY
  const bottleneck = findWorstBottleneck(traceData);

  // 3. Send that bottleneck to Gemini for expert analysis
  const analysisReport = await getAnalysis(bottleneck);

  return analysisReport;
}

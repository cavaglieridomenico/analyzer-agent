import fs from "fs/promises";
import { GoogleGenerativeAI } from "@google/generative-ai";
import "dotenv/config";
import { findWorstBottleneck } from "./utils/trace-analyzer";
import PersistentAgent from "./browser-controller";
import { SourceMapConsumer } from "source-map";
import axios from "axios";

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

// --- 2. Source Map Resolver ---
async function resolveSourceLocation(
  sourceMapUrl: string,
  line: number,
  column: number
) {
  try {
    const { data: sourceMap } = await axios.get(sourceMapUrl);
    const consumer = await new SourceMapConsumer(sourceMap);
    const originalPosition = consumer.originalPositionFor({
      line,
      column,
    });
    consumer.destroy();
    return originalPosition;
  } catch (error) {
    console.error(
      `[ANALYZER]: Failed to fetch or parse source map from ${sourceMapUrl}`,
      error
    );
    return null;
  }
}

// --- 3. AI ANALYZER (Sends bottleneck to Gemini) ---
async function getAnalysis(bottleneck: any) {
  console.log("[SERVER]: Sending bottleneck to Gemini for expert analysis...");

  if (bottleneck.summary) {
    return `Analysis skipped: ${bottleneck.summary}`;
  }

  const prompt = `
    You are an expert web performance analyst. I have captured a performance trace and
    identified the single worst bottleneck.

    Analyze the following JSON object which describes this task. The 'originalSourceLocation'
    field contains the exact location in the original source code.

    ${JSON.stringify(bottleneck, null, 2)}

    Provide a report in markdown format with the following sections:
    1.  **Root Cause Analysis:** Based on the task details, what is happening at **${
      bottleneck.originalSourceLocation?.source
    }:${bottleneck.originalSourceLocation?.line}** that is causing a ${
    bottleneck.duration_ms
  }ms bottleneck?
    2.  **Actionable Solution:** Provide a specific code improvement or strategy to fix the issue. Write a code snippet showing the "before" and "after" based on the identified bottleneck.
    3.  **Verification:** How can I verify that the fix has worked?
    `;

  const result = await makeApiCall(prompt);
  return result.response.text();
}

// --- 4. MAIN FUNCTION (Ties it all together) ---
/**
 * Reads the trace file, finds the worst bottleneck, resolves its source location,
 * and sends it to Gemini for analysis.
 */
export async function analyzeTraceFile(
  agent: PersistentAgent
): Promise<string> {
  // 1. Read the trace file
  console.log("[SERVER]: Reading trace.json file...");
  const traceFile = await fs.readFile("trace.json", "utf8");
  const traceData = JSON.parse(traceFile);

  // 2. Find the worst bottleneck LOCALLY
  const bottleneck = findWorstBottleneck(traceData);

  // 3. Resolve the source location using the agent
  if (bottleneck.stackFrame) {
    const { scriptId, url, lineNumber, columnNumber } = bottleneck.stackFrame;
    const sourceMapUrl = await agent.getSourceMapUrl(scriptId);

    if (sourceMapUrl) {
      // Resolve the full URL for the source map
      const fullSourceMapUrl = new URL(sourceMapUrl, url).toString();
      const originalLocation = await resolveSourceLocation(
        fullSourceMapUrl,
        lineNumber,
        columnNumber
      );
      (bottleneck as any).originalSourceLocation = originalLocation;
    }
  }

  // 4. Send that bottleneck to Gemini for expert analysis
  const analysisReport = await getAnalysis(bottleneck);

  return analysisReport;
}

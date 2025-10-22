import puppeteer, { Browser, CDPSession, Page, KnownDevices } from "puppeteer";
import fs from "fs";

/**
 * The PersistentAgent class is responsible for managing the browser instance
 * and handling all interactions with the Chrome DevTools Protocol (CDP).
 */
class PersistentAgent {
  public browser: Browser | null = null;
  public client: CDPSession | null = null;
  public page: Page | null = null;

  /**
   * Launches a new Chrome browser instance and establishes a CDP connection.
   */
  async launch(): Promise<void> {
    this.browser = await puppeteer.launch({
      headless: false, // Set to true for production environments
      args: ["--start-maximized"],
    });

    console.log("Browser launched.");

    // Get the default page that opens with the browser
    this.page = (await this.browser.pages())[0];

    // Emulate the most recent Pixel phone available
    const deviceName = "Pixel 2";
    const device = KnownDevices[deviceName];
    await this.page.emulate(device);
    console.log(`Emulating device: ${deviceName}`);

    // Create a CDP session to send raw CDP commands
    this.client = await this.page.target().createCDPSession();
    // Enable necessary CDP domains
    await this.client.send("Page.enable");
    await this.client.send("Debugger.enable"); // Enable the Debugger domain

    console.log("CDP connection established.");
  }

  /**
   * NEW METHOD: Retrieves source map details for a given script ID.
   * @param {string} scriptId - The ID of the script.
   * @returns {Promise<string | null>} The URL of the source map, or null if none exists.
   */
  async getSourceMapUrl(scriptId: string): Promise<string | null> {
    if (!this.client) {
      throw new Error("Agent not launched or Debugger not enabled");
    }
    console.log(`[AGENT]: Fetching source map URL for script ${scriptId}...`);
    try {
      // Get script details which include the sourceMapURL
      const response = await this.client.send("Debugger.getScriptSource", {
        scriptId: scriptId,
      });

      let sourceMapUrl = null;
      // The CDP response may include a sourceMapURL property directly
      if (response && (response as any).sourceMapURL) {
        sourceMapUrl = (response as any).sourceMapURL;
      } else {
        // If not, it might be embedded as a comment in the script source
        const source = response.scriptSource;
        const match = source.match(/\/\/# sourceMappingURL=(.*)/);
        if (match && match[1]) {
          sourceMapUrl = match[1].trim();
        }
      }

      if (sourceMapUrl) {
        console.log(`[AGENT]: Found source map URL: ${sourceMapUrl}`);
        // The URL might be relative, so we need to resolve it against the script's URL.
        // This part will be handled in the analysis controller.
        return sourceMapUrl;
      } else {
        console.log(`[AGENT]: No source map URL found for script ${scriptId}`);
        return null;
      }
    } catch (error) {
      console.error(
        `[AGENT]: Failed to get source map info for script ${scriptId}`,
        error
      );
      // Don't throw, just return null if source map isn't found
      return null;
    }
  }

  /**
   * Start a performance trace. Navigation is handled separately via `navigate()`.
   */
  async startTrace(): Promise<void> {
    if (!this.page || !this.client) {
      throw new Error("Agent has not been launched.");
    }

    // Start tracing with specific categories
    await this.client.send("Tracing.start", {
      transferMode: "ReturnAsStream",
      traceConfig: {
        includedCategories: [
          "-*", // Exclude everything first to be safe
          "devtools.timeline",
          "disabled-by-default-devtools.timeline",
          "disabled-by-default-devtools.timeline.frame",
          "disabled-by-default-devtools.timeline.stack",
          "disabled-by-default-v8.cpu_profiler",
          "disabled-by-default-v8.cpu_profiler.hires",
          "latencyInfo",
          "v8.execute", // Often needed for detailed JS profiling
          "blink.user_timing", // User Timing API marks
          "loading", // Network activity related
        ],
      },
    });
    console.log("Performance trace started.");
  }

  /**
   * Navigate the agent's page to a specific URL.
   * @param {string} url - The destination URL to open in the page.
   */
  async navigate(url: string): Promise<void> {
    if (!this.page) {
      throw new Error("Agent page is not available.");
    }
    await this.page.goto(url);
    console.log(`Navigated to ${url}`);
  }

  /**
   * Stops the performance trace and saves the data to a file.
   * @returns {Promise<void>} A promise that resolves when the trace is saved.
   */
  async stopTrace(): Promise<void> {
    if (!this.client) {
      throw new Error("Agent has not been launched.");
    }
    console.log("Performance trace stopping...");

    return new Promise(async (resolve) => {
      this.client!.once("Tracing.tracingComplete", async (event) => {
        const tracePath = "trace.json";
        const streamHandle = event.stream;

        if (!streamHandle) {
          console.warn("No trace stream handle found. Writing empty trace.");
          fs.writeFileSync(tracePath, "{}");
          resolve();
          return;
        }

        const writeStream = fs.createWriteStream(tracePath);

        const readStream = async (handle: string) => {
          let eof = false;
          while (!eof) {
            try {
              const { data, eof: readEof } = await this.client!.send(
                "IO.read",
                {
                  handle,
                }
              );
              writeStream.write(data);
              eof = readEof;
            } catch (e) {
              console.error("Error reading trace stream:", e);
              break;
            }
          }
          await this.client!.send("IO.close", { handle });
          writeStream.end();
          console.log(`Trace data saved to ${tracePath}`);
          resolve();
        };
        await readStream(streamHandle);
      });
      if (this.client) {
        await this.client.send("Tracing.end");
      }
    });
  }
}

export default PersistentAgent;

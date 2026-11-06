import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AxiError } from "axi-sdk-js";

const { callTool } = vi.hoisted(() => ({
  callTool: vi.fn(),
}));

vi.mock("../src/client.js", () => ({
  CdpError: class CdpError extends AxiError {
    constructor(
      message: string,
      public readonly code: string,
      public readonly suggestions: string[] = [],
    ) {
      super(message, code, suggestions);
    }
  },
  callTool,
  ensureBridge: vi.fn(),
  getSessionSnapshotIfRunning: vi.fn(),
  stopBridge: vi.fn(),
}));

import { main } from "../src/cli.js";
import { CdpError } from "../src/client.js";

function lines(count: number, render: (index: number) => string): string {
  return Array.from({ length: count }, (_, index) => render(index)).join("\n");
}

const consoleList = [
  "## Console messages",
  "Showing 1-121 of 121 (Page 1 of 1).",
  lines(
    120,
    (index) => `msgid=${index} [log] console message number ${index} (1 args)`,
  ),
  "msgid=120 [error] TAIL-SENTINEL-console (1 args)",
].join("\n");

const consoleDetail = [
  "ID: 7",
  `Message: error> Uncaught TypeError: example failure ${"x".repeat(1500)}`,
  "### Arguments",
  `Arg #0: {"detail":"${"y".repeat(1500)}"}`,
  "### Stack trace",
  lines(
    49,
    (index) =>
      `at frame${index} (https://example.com/assets/app.js:${index + 1}:1)`,
  ),
  "at tailFrame (https://example.com/assets/app.js:999:1) TAIL-SENTINEL-console-get",
  "... and 30 more frames",
  "Note: line and column numbers use 1-based indexing",
].join("\n");

const networkList = [
  "## Network requests",
  "Showing 1-121 of 121 (Page 1 of 1).",
  lines(
    120,
    (index) =>
      `reqid=${index} GET https://example.com/assets/file-${index}.js [200]`,
  ),
  "reqid=120 GET https://example.com/TAIL-SENTINEL-network [403]",
].join("\n");

const networkDetail = [
  `## Request https://example.com/api/items?token=${"a".repeat(5000)}`,
  "Status: 403",
  "### Request Headers",
  "- accept:application/json",
  "- user-agent:Example/1.0",
  "### Response Headers",
  "- content-type:application/json",
  "### Response Body",
  "Saved to /tmp/example.network-response.",
  "### Request failed with",
  "net::ERR_EXAMPLE TAIL-SENTINEL-network-get",
].join("\n");

const cases = [
  {
    command: "console",
    args: ["--type", "error", "--limit", "50", "--page", "1"],
    text: consoleList,
    sentinel: "TAIL-SENTINEL-console (1 args)",
  },
  {
    command: "console-get",
    args: ["7"],
    text: consoleDetail,
    sentinel: "TAIL-SENTINEL-console-get",
  },
  {
    command: "network",
    args: ["--type", "fetch", "--limit", "20", "--page", "2"],
    text: networkList,
    sentinel: "TAIL-SENTINEL-network [403]",
  },
  {
    command: "network-get",
    args: [
      "7",
      "--response-file",
      "./resp.json",
      "--request-file",
      "./req.json",
    ],
    text: networkDetail,
    sentinel: "TAIL-SENTINEL-network-get",
  },
];

describe("diagnostic commands --full", () => {
  let write: ReturnType<typeof vi.spyOn>;

  function printed(): string {
    return write.mock.calls.map((call) => String(call[0])).join("");
  }

  beforeEach(() => {
    vi.spyOn(process, "cwd").mockReturnValue("/caller/dir");
    write = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(() => {
    callTool.mockReset();
    process.exitCode = undefined;
    vi.restoreAllMocks();
  });

  it("uses native samples longer than 5000 characters", () => {
    for (const sample of cases) {
      expect(sample.text.length).toBeGreaterThan(5000);
      expect(sample.text.indexOf(sample.sentinel)).toBeGreaterThan(2000);
    }
  });

  it.each(cases)(
    "$command --full prints the native text exactly",
    async ({ command, args, text, sentinel }) => {
      callTool.mockResolvedValueOnce(text);

      await main([command, ...args, "--full"]);

      const output = printed();
      expect(output).toContain(text);
      expect(output).toContain(sentinel);
      expect(output).not.toContain("(truncated,");
      expect(process.exitCode ?? 0).toBe(0);
    },
  );

  it.each(cases)(
    "$command keeps the compact cap without --full",
    async ({ command, args, text, sentinel }) => {
      callTool.mockResolvedValueOnce(text);

      await main([command, ...args]);

      const output = printed();
      expect(output).not.toContain(sentinel);
      expect(output).toContain(`(truncated, ${text.length} chars total)`);
    },
  );

  it.each(cases)(
    "$command sends the same MCP call with and without --full",
    async ({ command, args, text }) => {
      callTool.mockResolvedValue(text);

      await main([command, ...args]);
      await main([command, ...args, "--full"]);

      expect(callTool).toHaveBeenCalledTimes(2);
      expect(callTool.mock.calls[1]).toEqual(callTool.mock.calls[0]);
    },
  );

  it("prints an empty native console list unchanged with --full", async () => {
    callTool.mockResolvedValueOnce("<no console messages found>");

    await main(["console", "--full"]);

    expect(printed()).toContain("console:\n<no console messages found>");
    expect(process.exitCode ?? 0).toBe(0);
  });

  it("surfaces an MCP failure from network-get --full like the compact call", async () => {
    const failure = () =>
      new CdpError("Request with id 7 not found", "BROWSER_ERROR");
    callTool.mockRejectedValueOnce(failure());
    await main(["network-get", "7"]);
    const compactOutput = printed();
    const compactExitCode = process.exitCode;

    write.mockClear();
    process.exitCode = undefined;
    callTool.mockRejectedValueOnce(failure());
    await main(["network-get", "7", "--full"]);

    expect(compactOutput).toContain("Request with id 7 not found");
    expect(printed()).toBe(compactOutput);
    expect(process.exitCode).toBe(compactExitCode);
  });
});

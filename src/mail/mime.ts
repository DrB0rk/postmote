import { simpleParser } from "mailparser";

export async function parseMessage(source: Buffer) {
  return simpleParser(source, { skipTextToHtml: true, keepCidLinks: true, maxHtmlLengthToParse: 1024 * 1024 });
}

export function safeFilename(filename: string | undefined): string | null {
  if (!filename) return null;
  const basename = filename.replace(/\\/g, "/").split("/").pop() ?? "";
  return basename.replace(/[\x00-\x1f\x7f]/g, "").slice(0, 255) || null;
}

export function boundedText(value: string | undefined, maxBytes = 1024 * 1024) {
  if (value === undefined) return { text:null, truncated:false };
  const bytes=Buffer.from(value,"utf8");
  return { text:bytes.subarray(0,maxBytes).toString("utf8"), truncated:bytes.length>maxBytes };
}

export function hiddenPrompt(label: string, input: NodeJS.ReadStream = process.stdin, output: NodeJS.WriteStream = process.stdout): Promise<string> {
  if (!input.isTTY || !output.isTTY) throw new Error("TTY_REQUIRED");
  return new Promise((resolve, reject) => {
    output.write(label);
    input.setRawMode(true);
    input.resume();
    input.setEncoding("utf8");
    let value = "";
    const finish = (): void => {
      input.setRawMode(false);
      input.pause();
      input.off("data", onData);
      output.write("\n");
      resolve(value);
    };
    const onData = (chunk: string): void => {
      for (const character of chunk) {
        if (character === "\u0003") {
          input.setRawMode(false);
          input.pause();
          input.off("data", onData);
          reject(new Error("CANCELLED"));
          return;
        }
        if (character === "\r" || character === "\n") {
          finish();
          return;
        }
        if (character === "\u007f" || character === "\b") value = value.slice(0, -1);
        else value += character;
      }
    };
    input.on("data", onData);
  });
}


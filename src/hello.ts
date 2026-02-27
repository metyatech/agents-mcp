import { pathToFileURL } from "url";

export const HELLO_WORLD_MESSAGE = "Hello, World!";

export function printHelloWorld(): void {
  console.log(HELLO_WORLD_MESSAGE);
}

const invokedPath = process.argv[1];

if (invokedPath) {
  const invokedFileUrl = pathToFileURL(invokedPath).href;

  if (import.meta.url === invokedFileUrl) {
    printHelloWorld();
  }
}

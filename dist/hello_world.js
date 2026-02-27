import { pathToFileURL } from "url";
import { printHelloWorld } from "./hello.js";
export { printHelloWorld };
const invokedPath = process.argv[1];
if (invokedPath) {
    const invokedFileUrl = pathToFileURL(invokedPath).href;
    if (import.meta.url === invokedFileUrl) {
        printHelloWorld();
    }
}
//# sourceMappingURL=hello_world.js.map
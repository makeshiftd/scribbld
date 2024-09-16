import { serveDir } from "@std/http/file-server";
import { STATUS_CODE } from "@std/http/status"
import * as log from "@std/log";

import { type Handler, type Route, route } from "@std/http/route";

interface DocGenerator {
    finished: Promise<void>;
    run: () => Promise<void>;
}

function postDocHandler(generator: DocGenerator): Handler {
    return async (req: Request): Promise<Response> => {
        const url = new URL(req.url);
        const path = url.pathname.replace(/^\/docs/, "./content");
        await Deno.writeFile(path, await req.bytes());
        
        try {
            await generator.run();
        } catch(err) {
            return new Response(err, { status: STATUS_CODE.BadRequest });
        }
        return new Response(null, { status: STATUS_CODE.NoContent });
    };
}

function generate(
    delay: number,
    options?: { signal?: AbortSignal },
): DocGenerator {
    const signal = options?.signal || AbortSignal.any([]);

    const decoder = new TextDecoder("utf-8");

    const hugoCmd = new Deno.Command("hugo");

    const runCommands = async () => {
        const startTime = performance.now();
        const output = await hugoCmd.output();
        if (!output.success) {
            const errorRegex = /^Error:\s*/;
            const stdout = decoder.decode(output.stdout);

            let message = stdout.split("\n").find((line) => {
                return Boolean(line.match(errorRegex));
            });
            message = message
                ? message.replace(errorRegex, "hugo: ")
                : `hugo: error unknown: ${output.code}`;

            log.warn(message);
            throw new Error(message);
        }

        const elapsedTime = Math.round(performance.now() - startTime);
        log.info(`hugo: command completed: ${elapsedTime}ms`);
    };

    // Serialize command execution
    let pending = Promise.resolve();
    function runCommandsNext(): Promise<void> {
        pending = pending.finally(runCommands);
        return pending;
    }

    // Run commands periodically
    async function runCommandsSafe(): Promise<void> {
        try {
            await runCommandsNext();
        } catch (_) {
            // Error logged above,
            // so just ignore it here
        }
    }

    let interval = 0;
    function stopCmdsInterval() {
        interval && clearInterval(interval);
    }
    function startCmdsInterval() {
        stopCmdsInterval();
        interval = setInterval(runCommandsSafe, delay);
    }

    if (!signal.aborted) {
        startCmdsInterval();
        signal.addEventListener("abort", () => {
            stopCmdsInterval();
        });
    }

    const finished = new Promise<void>((resolve) => {
        if (!signal.aborted) {
            signal.addEventListener("abort", () => {
                pending.finally(resolve);
            });
        } else {
            resolve();
        }
    });

    // Run commands on demand
    const run = async (): Promise<void> => {
        signal.throwIfAborted();
        try {
            stopCmdsInterval();
            return await runCommandsNext();
        } finally {
            startCmdsInterval();
        }
    };

    return {
        finished,
        run,
    };
}

function defaultHandler(_req: Request) {
    return new Response("Not found A", { status: 404 });
}

async function main() {
    const mainCtlr = new AbortController();

    const generator = generate(30000, { signal: mainCtlr.signal });

    const handlers: Route[] = [
        {
            pattern: new URLPattern({ pathname: "/srcs/*" }),
            handler: (req: Request) => {
                return serveDir(req, {
                    fsRoot: "content",
                    urlRoot: "srcs",
                });
            },
        },
        {
            method: "POST",
            pattern: new URLPattern({ pathname: "/docs/*" }),
            handler: postDocHandler(generator),
        },
        {
            pattern: new URLPattern({ pathname: "/docs/*" }),
            handler: (req: Request) => {
                return serveDir(req, {
                    fsRoot: "public",
                    urlRoot: "docs",
                });
            },
        },
    ];

    const server = Deno.serve(
        { signal: mainCtlr.signal },
        route(handlers, defaultHandler),
    );

    await Promise.allSettled([
        generator.finished,
        server.finished,
    ]);
}

await main();

---
title: "Explicit Resource Management: Exploring JavaScript's and TypeScript's new feature"
date: 2023-11-13
description: await using connection = await connect()

extra:
  lang: en
  links:
    - rel: license
      text: CC BY-SA 4.0
      href: https://creativecommons.org/licenses/by-sa/4.0/
    - rel: alternate
      text: read in russian
      href: /articles/js-explicit-resource-management-ru
---

One of my favorite new features of JavaScript and TypeScript is [explicit resource management]. It brings new syntax, `using foobar = ...`, that enables [RAII], reducing boilerplate when managing the lifecycle of various resources.

[explicit resource management]: https://github.com/tc39/proposal-explicit-resource-management
[raii]: https://en.wikipedia.org/wiki/Resource_acquisition_is_initialization

![a demo of new syntax](cover.png)

In this article, I will explore this feature as implemented in [TypeScript 5.2.0] with the [disposablestack] polyfill. I will mention both sync and async resources, `DisposableStack`/`AsyncDisposableStack`, and a non-obvious mistake I've made when using the new feature. Also, along the way, I will use some newer features of Node.js, that some people might not know about yet.

[TypeScript 5.2.0]: https://devblogs.microsoft.com/typescript/announcing-typescript-5-2/#using-declarations-and-explicit-resource-management
[disposablestack]: https://www.npmjs.com/package/disposablestack

All of the code is available [in the repo].

[in the repo]: https://github.com/iliazeus/js-disposable-demo

## Prerequisites

I will use a more-or-less recent version of Node.js:

```bash
$ node --version
v20.3.1
```

But all of the features I'll use are available at least as of Node 18.16.1 LTS.

I'll need TypeScript 5.2 for the syntax-level, and a polyfill for the library-level part of the feature:

```bash
$ npm i -D typescript@5.2 @types/node@20
$ npm i disposablestack
```

Finally, to set up the compiler. For this new syntax, I'll need the `"lib": "esnext"` or `"lib": "esnext.disposable"` options. I will also use ES modules.

<details>
<summary>Full tsconfig.json</summary>

```javascript
// tsconfig.json

{
  "compilerOptions": {
    "target": "es2022",
    "lib": ["esnext", "dom"],
    "module": "nodenext",
    "rootDir": "./src",
    "outDir": "./dist",
    "skipLibCheck": true
  }
}
```

</details>

## Sync resources: event subscriptions

One of the simpler kinds of resource that a JavaScript or TypeScript programmer might encounter is an event subscription. Its lifecycle begins when subscribing to an event, and ends when unsubscribing from it. And in a lot of cases, forgetting to properly unsubscribe from an event will lead to memory leaks - an event handler is often a closure that retains a reference to the event emitter object, creating a reference cycle:

```javascript
let listener = new SomeListener();
let emitter = new HeavyObject();

emitter.on("event", () => listener.onEvent(emitter));

/* ... */

emitter = null;
// emitter won't be garbage collected
// as long as listenre is alive
```

Using event subscriptions as an example, let's is what the new resource management syntax looks like. First, to implement the lifecycle logic:

```javascript
// src/event-subscription.ts

import "disposablestack/auto";
import { EventEmitter } from "node:events";

export function subscribe(obj: EventEmitter, e: string, fn: (...args: any[]) => void): Disposable {
  obj.on(e, fn);
  return { [Symbol.dispose]: () => obj.off(e, fn) };
}
```

The `Disposable` protocol requires objects to have a `[Symbol.dispose]()` method - this method will be called to free the resource.

To demonstrate this resource's usage, I will write a unit test for `subscribe()` using one of the newer Node.js features - a [built-in test runner]:

[built-in test runner]: https://nodejs.org/dist/latest-v20.x/docs/api/test.html

```javascript
// src/event-subscription.test.ts

import { subscribe } from "./event-subscription.js";

import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { describe, it } from "node:test";


describe("event-subscription", () => {
  it("is disposed at scope exit", () => {
    const expectedEvents = [1, 2, 3];
    const actualEvents: number[] = [];

    const obj = new EventEmitter();
    const fn = (e: number) => actualEvents.push(e);

    {
      // initializing the resource with a `using` declaration
      using guard = subscribe(obj, "event", fn);

      // the resource is alive till the end of the variable scope
      for (const e of expectedEvents) obj.emit("event", e);

      // end of scope for `guard`
      // guard[Symbol.dispose]() will be called here
    }

    obj.emit("event", 123);

    assert.deepEqual(actualEvents, expectedEvents);
    assert.equal(obj.listenerCount("event"), 0);
  });
});
```

Let's run our test:

```bash
$ npm test | grep event-subscription
# Subtest: event-subscription
ok 1 - event-subscription
```

## Async resources: open files

When talking about resource lifecycle in Node.js, most people really mean the ones I'll call _async resources_. They include open files, sockets, database connections - in short, any resources that fit the following usage model:

```javascript
let resource: Resource;
try {
  // the resource is initialized with an async method
  resource = await Resource.open();

  // doing stuff with resource
} finally {
  // the resource is freed with an async method
  await resource?.close();
}
```

From the first glance, it's not really clear why the new syntax was introduced. I mean, we already have `finally`, right? But as soon as we have to deal with several resource at once, the boilerplate starts to pile up:

```javascript
let resourceA: ResourceA;
try {
  resourceA = await ResourceA.open();

  let resourceB: ResourceB;
  try {
    resourceB = await ResourceB.open(resourceA);
  } finally {
    await resourceB?.close();
  }
} finally {
  await resourceA?.close();
}
```

Adding to that, the `try` and `finally` blocks are different scopes, so we always need to declare mutable variables, instead of using `const`.

The new `using` syntax makes this much more manageable:

```javascript
// src/file.test.ts

import { openFile } from "./file.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";

describe("file", () => {
  it("is disposed at scope exit", async () => {
    {
      await using file = await openFile("dist/test.txt", "w");
      await file.writeFile("test", "utf-8");
    }

    {
      await using file = await openFile("dist/test.txt", "r");
      assert.equal(await file.readFile("utf-8"), "test");
    }
  });
});
```

Notice the `await using file = await ...`. There are two `await`s here. The first `await` means async disposal - that is, executing `await file[Symbol.asyncDispose]()` at the end of scope. The second `await` means async initialization - it is, in fact, just a regular `await openFile()` expression.

I'll implement `openFile` as a thin wrapper over the existing `fs.FileHandle` of Node.js.

```javascript
// src/file.ts

import "disposablestack/auto";
import * as fs from "node:fs/promises";
import { Writable } from "node:stream";

// the type of our resource is a union of AsyncDisposable and the fs.FileHandle
export interface DisposableFile extends fs.FileHandle, AsyncDisposable {
  // this helper method will become useful later
  writableWebStream(options?: fs.CreateWriteStreamOptions): WritableStream;
}

export async function openFile(path: string, flags?: string | number): Promise<DisposableFile> {
  const file = await fs.open(path, flags);

  // using Object.assign() to monkey-patch the disposal function into the object
  return Object.assign(file, {
    [Symbol.asyncDispose]: () => file.close(),

    writableWebStream: (options: fs.CreateWriteStreamOptions = { autoClose: false }) =>
      Writable.toWeb(file.createWriteStream(options)),
  });
}
```

Let's run the tests:

```bash
$ npm test | grep file
# Subtest: file
ok 2 - file
```

## The "async-sync": mutexes

From the first glance, the `await using foo = await ...` syntax can seem needlessly repetitive. But the thing is, there are resources that only require the initialization to be async, as well as those that only require async disposal.

As a demonstration of an "async init - sync dispose" resource, here is a RAII mutex:

```javascript
// src/mutex.test.ts

import { Mutex } from "./mutex.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

describe("mutex-guard", () => {
  it("is disposed at scope exit", async () => {
    const mutex = new Mutex();
    let value: number = 0;

    const task = async () => {
      for (let i = 0; i < 5; i++) {
        // async init - might have to wait until mutex becomes free
        // sync dispose - just notifying other awaiters
        using guard = await mutex.acquire();

        // the scope of `guard` becomes a critical section

        const newValue = value + 1;
        await sleep(100);
        value = newValue;

        // comment out the `using guard` line to see a race condition
      }
    };

    await Promise.all([task(), task()]);

    assert.equal(value, 10);
  });
});
```

I impmented `Mutex` as an async factory of `Disposable` objects:

```javascript
// src/mutex.ts

import "disposablestack/auto";

export class Mutex {
  #promise: Promise<void> | null = null;

  async acquire(): Promise<Disposable> {
    while (this.#promise) await this.#promise;

    let callback: () => void;
    this.#promise = new Promise((cb) => callback = cb);

    return {
      [Symbol.dispose]: () => {
        this.#promise = null;
        callback!();
      }
    };
  }
}
```

Let's run the tests:

```bash
$ npm test | grep mutex
# Subtest: mutex-guard
ok 3 - mutex-guard
```

## The "sync-async": task queues

As an example of a "sync init - async dispose" object, here is a simple task queue:

```javascript
// src/task-queue.test.ts

import { TaskQueue } from "./task-queue.js";

import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";

describe("task-queue", () => {
  it("is disposed at scope exit", async () => {
    let runningTaskCount = 0;
    let maxRunningTaskCount = 0;

    const task = async () => {
      runningTaskCount += 1;
      maxRunningTaskCount = Math.max(maxRunningTaskCount, runningTaskCount);

      await sleep(100);

      runningTaskCount -= 1;
    };

    {
      await using queue = new TaskQueue({ concurrency: 2 });

      queue.push(task);
      queue.push(task);
      queue.push(task);
      queue.push(task);

      // at the end of scope, it awaits all remaining tasks in the queue
    }

    assert.equal(runningTaskCount, 0);
    assert.equal(maxRunningTaskCount, 2);
  });
});
```

The implementation is mostly straightforward:

<details>
<summary>Task queue implementation</summary>

```javascript
// src/task-queue.ts

import "disposablestack/auto";
import { EventEmitter, once } from "node:events";

export type Task = () => Promise<void>;

export class TaskQueue extends EventEmitter {
  // сейчас это еще не совсем очевидно, но это поле - очень важная деталь
  readonly resources = new AsyncDisposableStack();

  #concurrency: number;
  #tasks: Task[] = [];
  #runningTaskCount: number = 0;

  constructor(options: { concurrency: number }) {
    super();
    this.#concurrency = options.concurrency;
    this.on("taskFinished", () => this.#runNextTask());
  }

  push(task: Task): void {
    this.#tasks.push(task);
    this.#runNextTask();
  }

  #runNextTask(): void {
    if (this.#runningTaskCount >= this.#concurrency) return;

    const nextTask = this.#tasks.shift()!;
    if (!nextTask) return;

    this.#runningTaskCount += 1;

    nextTask()
      .catch((error) => {
        this.emit("error", error);
      }).finally(() => {
        this.#runningTaskCount -= 1;
        this.emit("taskFinished");
      });
  }

  async [Symbol.asyncDispose](): Promise<void> {
    while (this.#tasks.length > 0 || this.#runningTaskCount > 0) {
      await once(this, "taskFinished").catch(() => { });
    }

    await this.resources.disposeAsync();
  }
}
```

</details>

Running our simple tests:

```bash
$ npm test | grep queue
# Subtest: task-queue
ok 4 - task-queue
```

## Putting it all together: fetchCat()

As a simple exercise, let's write a function that uses all four of the resources defined earlier:

```javascript
// src/fetch-cat.ts

import { subscribe } from "./event-subscription.js";
import { openFile } from "./file.js";
import { Mutex } from "./mutex.js";
import { TaskQueue } from "./task-queue.js";

/**
 * Fetch all `urls` with HTTP GET requests, concatenate all the responses in any order,
 * and write them to `outPath`.
 *
 * @param options.concurrency max number of concurrent requests
 * @param options.onError is called on request error
 */
export async function fetchCat(
  options: {
    urls: string[],
    outPath: string,
    concurrency: number,
    onError: (error: any) => void,
  },
): Promise<void> {
  const { urls, outPath, concurrency, onError } = options;

  // a task queue to limit the concurrency
  await using taskQueue = new TaskQueue({ concurrency });

  // an event subscription treated as a resource
  using errorSubscription = subscribe(taskQueue, "error", onError);

  // synchronize file writes with a mutex
  const outFileMutex = new Mutex();

  // ensure the file is closed at the end of scope
  await using outFile = await openFile(outPath, "w");

  for (const url of urls) {
    taskQueue.push(async () => {
      // a brower-compatible global fetch() is also one]
      // of the newer Node.js features
      const response = await fetch(url);

      {
        using outFileGuard = await outFileMutex.acquire();

        // as are the browser-compatible data streams
        await response.body?.pipeTo(outFile.writableWebStream());
      }
    });
  }
}
```

Wrapping this up into a script with another Node.js feature - a built-in CLI args parser:

<details>
<summary>main.ts</summary>

```javascript
// src/main.ts

import { parseArgs } from "node:util";

import { fetchCat } from "./fetch-cat.js";

const explain = (error: Error) => {
  let message = error.message;

  for (let e = error.cause as Error; e; e = e.cause as Error) {
    message += ': ' + e.message;
  }

  return message;
}

const args = parseArgs({
  strict: true,
  allowPositionals: true,
  options: {
    outPath: {
      short: 'o',
      type: 'string',
    },
    concurrency: {
      short: 'j',
      type: 'string',
      default: '2',
    },
  },
});

if (!args.values.outPath) {
  console.log('missing required option: -o (--outPath)');
  process.exit(1);
}

await fetchCat({
  urls: args.positionals,
  outPath: args.values.outPath,
  concurrency: Number(args.values.concurrency),
  onError: (e) => {
    console.error(explain(e));
    process.exitCode = 1;
  },
});
```

</details>

To test this, I will use a `urls.txt` file with a list of urls, and a few fakes:

```
https://habr.com/ru/companies/ruvds/articles/346442/comments/
https://habr.com/ru/articles/203048/comments/
https://asdfasdfasdfasdf
https://habr.com/ru/articles/144758/comments/
https://habr.com/ru/companies/floor796/articles/673318/comments/
https://habr.com/ru/companies/skyeng/articles/487764/comments/
https://habr.com/ru/articles/177159/comments/
https://habr.com/ru/articles/124899/comments/
https://habr.com/ru/articles/149237/comments/
https://foobarfoobarfoobar
https://habr.com/ru/articles/202304/comments/
https://habr.com/ru/articles/307822/comments/
```

Let's try this out:

```bash
$ npm run demo

> demo
> xargs npm run start -- -o ./cat.html < ./urls.txt


> start
> tsc && node --max-old-space-size=8 ./dist/main-incorrect.js -o ./cat.html https://habr.com/ru/companies/ruvds/articles/346442/comments/ https://habr.com/ru/articles/203048/comments/ https://asdfasdfasdfasdf https://habr.com/ru/articles/144758/comments/ https://habr.com/ru/companies/floor796/articles/673318/comments/ https://habr.com/ru/companies/skyeng/articles/487764/comments/ https://habr.com/ru/articles/177159/comments/ https://habr.com/ru/articles/124899/comments/ https://habr.com/ru/articles/149237/comments/ https://foobarfoobarfoobar https://habr.com/ru/articles/202304/comments/ https://habr.com/ru/articles/307822/comments/
```

Huh... The script won't finish, and the output is empty. Looks like a bug.

## The non-obvious mistake

To find my mistake, let's inspect the code a bit closer:

```javascript
// src/fetch-cat.ts

import { subscribe } from "./event-subscription.js";
import { openFile } from "./file.js";
import { Mutex } from "./mutex.js";
import { TaskQueue } from "./task-queue.js";

export async function fetchCat(
  options: {
    urls: string[],
    outPath: string,
    concurrency: number,
    onError: (error: any) => void,
  },
): Promise<void> {
  const { urls, outPath, concurrency, onError } = options;

  // notice the resource init order
  await using taskQueue = new TaskQueue({ concurrency });
  using errorSubscription = subscribe(taskQueue, "error", onError);
  await using outFile = await openFile(outPath, "w");

  const outFileMutex = new Mutex();

  for (const url of urls) {
    taskQueue.push(async () => {
      const response = await fetch(url);

      {
        using outFileGuard = await outFileMutex.acquire();

        await response.body?.pipeTo(outFile.writableWebStream());
      }
    });
  }

  // This is the end of scope for both `outFile` and `taskQueue`.
  // They are disposed of in reverse declaration order.
  // That means that `outFile` will be closed before `taskQueue` is finished!
}
```

There is a logic error here: the `outFile` lifetime should be bound not by the current scope, but by the lifetime of all the remaining queue tasks. The file should be closed only when all the tasks are done.

Sadly, Node.js isn't smart enough to automatically prolong the lifetimes of values captured by a closure. That means I'll have to bind them manually, using `AsyncDisposableStack` - a container that aggregates several `AsyncDisposable`s together, freeing them all at once.

```javascript
// src/fetch-cat.ts

import { subscribe } from "./event-subscription.js";
import { openFile } from "./file.js";
import { Mutex } from "./mutex.js";
import { TaskQueue } from "./task-queue.js";

export async function fetchCat(
  options: {
    urls: string[],
    outPath: string,
    concurrency: number,
    onError: (error: any) => void,
  },
): Promise<void> {
  const { urls, outPath, concurrency, onError } = options;

  await using taskQueue = new TaskQueue({ concurrency });

  // The `taskQueue.resources` field is an AsyncDisposableStack.
  // As part of TaskQueue's contract, it is disposed only after
  // all the tasks are done

  const errorSubscription = subscribe(taskQueue, "error", onError);
  taskQueue.resources.use(errorSubscription); // связываем время жизни

  const outFile = await openFile(outPath, "w");
  taskQueue.resources.use(outFile); // связываем время жизни

  const outFileMutex = new Mutex();

  for (const url of urls) {
    taskQueue.push(async () => {
      const response = await fetch(url);

      {
        using outFileGuard = await outFileMutex.acquire();
        await response.body?.pipeTo(outFile.writableWebStream());
      }
    });
  }

  // Only the `taskQueue` resource is bound directly to this scope.
  // When it is disposed of, it first awaits all remaining queue tasks,
  // and only then disposes of all the `taskQueue.resources`.
  // Only then will the `outFile` be closed.
}
```

Let's test this out:

Проверим, получилось ли у нас исправить дело:

```bash
$ npm run demo

> demo
> xargs npm start -- -o ./cat.html < ./urls.txt


> start
> tsc && node --max-old-space-size=8 ./dist/main.js -o ./cat.html https://habr.com/ru/companies/ruvds/articles/346442/comments/ https://habr.com/ru/articles/203048/comments/ https://asdfasdfasdfasdf https://habr.com/ru/articles/144758/comments/ https://habr.com/ru/companies/floor796/articles/673318/comments/ https://habr.com/ru/companies/skyeng/articles/487764/comments/ https://habr.com/ru/articles/177159/comments/ https://habr.com/ru/articles/124899/comments/ https://habr.com/ru/articles/149237/comments/ https://foobarfoobarfoobar https://habr.com/ru/articles/202304/comments/ https://habr.com/ru/articles/307822/comments/

fetch failed: getaddrinfo ENOTFOUND asdfasdfasdfasdf
fetch failed: getaddrinfo ENOTFOUND foobarfoobarfoobar
```

Excellent! All the urls (excluding fakes) were fetched and written to `./cat.html`, as intended.

As a general rule, all `Disposable` resources that hold sub-resources should hold them in a `DisposableStask`, disposing it inside their own `dispose()`. Same goes for `AsyncDisposable` and `AsyncDisposableStask`, of course.

## `article[Symbol.dispose]()`

The dedicated RAII syntax isn't a novel idea for a programming language - [C# has it], so [does Python], and now JavaScript and TypeScript. This implementation, of course, isn't perfect, and has its own share of non-obvious behaviors. But still, I am glad that we finally have such a syntax - and, I hope, I managed to explain why!

[C# has it]: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-8.0/using#using-declaration
[does Python]: https://docs.python.org/3/reference/compound_stmts.html#the-with-statement

All the code is available [in the repo].

[in the repo]: https://github.com/iliazeus/js-disposable-demo

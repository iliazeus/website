---
title: "Явное управление ресурсами: пробуем новую фичу JavaScript и TypeScript"
date: 2023-07-25
description: await using connection = await connect()

extra:
  lang: ru
  links:
    - rel: license
      text: CC BY-SA 4.0
      href: https://creativecommons.org/licenses/by-sa/4.0/
    - rel: alternate
      text: habr
      href: https://habr.com/ru/articles/745904/
    - rel: alternate
      text: read in english
      href: /articles/js-explicit-resource-management-en
---

Одной из самых интересных грядущих новинок JavaScript и TypeScript для меня является [явное управление ресурсами]. Новый синтаксис `using foobar = ...` реализует идиому [RAII], позволяя писать намного менее многословный код, управляющий какими-либо ресурсами.

[явное управление ресурсами]: https://github.com/tc39/proposal-explicit-resource-management
[raii]: https://ru.wikipedia.org/wiki/Получение_ресурса_есть_инициализация

![демонстрация нового синтаксиса](cover.png)

В этой статье я хочу на примерах разобрать эту фичу — в том виде, в котором она сейчас доступна в [TypeScript 5.2.0-beta] с полифиллом [disposablestack]. Я рассмотрю синхронные и асинхронные ресурсы, `DisposableStack`/`AsyncDisposableStack`, а также приведу пример неочевидного бага, в который попался я сам. По пути я также коснусь нескольких других нововведений Node.js, про которые, возможно, еще знают не все.

[typescript 5.2.0-beta]: https://devblogs.microsoft.com/typescript/announcing-typescript-5-2-beta/#using-declarations-and-explicit-resource-management
[disposablestack]: https://www.npmjs.com/package/disposablestack

Весь код доступен [в репозитории].

[в репозитории]: https://github.com/iliazeus/js-disposable-demo

## Что нам понадобится для новых фич

Я буду использовать довольно новую версию Node.js:

```bash
$ node --version
v20.3.1
```

Но все фичи, которые я буду использовать, доступны и в последней LTS-версии Node 18.16.1.

Нам понадобится установить бета-версию TypeScript, а также полифиллы для библиотечной части пропозала:

```bash
$ npm i -D typescript@5.2-beta @types/node@18
$ npm i disposablestack
```

<details><summary>Полный package.json</summary>

```javascript
// package.json

{
  "private": true,
  "type": "module",
  "scripts": {
    "demo": "xargs npm start -- -o ./cat.html < ./urls.txt",
    "start": "tsc && node --max-old-space-size=8 ./dist/main.js",
    "test": "tsc && node --test ./dist",

    "start:incorrect": "tsc && node --max-old-space-size=8 ./dist/main-incorrect.js",
    "demo:incorrect": "xargs npm run start:incorrect -- -o ./cat.html < ./urls.txt"
  },
  "engines": {
    "node": ">=18.16.0"
  },
  "devDependencies": {
    "@types/node": "^18.16.19",
    "typescript": "^5.2.0-beta"
  },
  "dependencies": {
    "disposablestack": "^1.1.0"
  }
}
```

</details>

Также понадобится настроить IDE так, чтобы она тоже поддерживала новый синтаксис. Я пользуюсь Visual Studio Code; для нее нужно прописать в настройках проекта путь к локальному компилятору, а также переключиться на стандартный форматтер кода — `prettier` еще не переваривает новый синтаксис:

```javascript
// .vscode/settings.json

{
  "typescript.tsdk": "node_modules/typescript/lib",
  "[typescript]": {
    "editor.defaultFormatter": "vscode.typescript-language-features"
  }
}
```

Наконец, понадобится настроить сам компилятор. Для поддержки нового синтаксиса нужны опции `"lib": "esnext"` или `"lib": "esnext.disposable"`. Я также включаю поддержку ES-модулей.

<details>

<summary>Полный tsconfig.json</summary>

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

## Синхронные ресурсы: подписки на события

Самый простой пример ресурса, за которым в JavaScript и TypeScript нужно следить вручную — это подписки на события. Конкретнее, от них во многих случаях нужно не забывать отписываться. В замыкании-обработчике события зачастую есть ссылка на объект-источник, а у источника есть ссылка на обработчик, что порождает цикл из ссылок на объекты в куче. Это может порождать неявные "висящие" ссылки, которые не дадут GC собрать эту память:

```javascript
let listener = new SomeListener();
let emitter = new HeavyObject();

emitter.on("event", () => listener.onEvent(emitter));

/* ... */

emitter = null;
// emitter не соберется до тех пор, пока жив listener
```

Давайте на примере подписок посмотрим, как выглядит синтаксис управления ресурсами. Вот создание объекта-ресурса:

```javascript
// src/event-subscription.ts

import "disposablestack/auto";
import { EventEmitter } from "node:events";

export function subscribe(obj: EventEmitter, e: string, fn: (...args: any[]) => void): Disposable {
  obj.on(e, fn);
  return { [Symbol.dispose]: () => obj.off(e, fn) };
}
```

Такие объекты должны удовлетворять интерфейсу `Disposable` — иметь метод `[Symbol.dispose]`, который и будет осуществлять освобождение ресурсов.

В качестве примера использования, напишем юнит-тест для функции `subscribe()`, используя еще одну из недавних фич Node.js — встроенную [поддержку запуска тестов]:

[поддержку запуска тестов]: https://nodejs.org/dist/latest-v20.x/docs/api/test.html

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
      // инициализируем ресурс с помощью ключевого слова using
      using guard = subscribe(obj, "event", fn);

      // ресурс живет до тех пор, пока мы не выйдем из области
      // видимости переменной guard
      for (const e of expectedEvents) obj.emit("event", e);

      // конец области видимости
      // здесь выполняется guard[Symbol.dispose]()
    }

    obj.emit("event", 123);

    assert.deepEqual(actualEvents, expectedEvents);
    assert.equal(obj.listenerCount("event"), 0);
  });
});
```

Все работает как ожидается:

```bash
$ npm test | grep event-subscription
# Subtest: event-subscription
ok 1 - event-subscription
```

## Асинхронные ресурсы: открытые файлы

Когда говорят про ручное управление ресурсами в контексте Node.js, чаще всего имеют в виду то, что я назову _асинхронными ресурсами_. Это открытые файлы, сокеты, подключения к базе данных — другими словами, те, что укладываются в такую модель использования:

```javascript
let resource: Resource;
try {
  // инициализируем ресурс асинхронным методом
  resource = await Resource.open();

  // используем ресурс
} finally {
  // освобождаем ресурс асинхронным методом
  await resource?.close();
}
```

Казалось бы, никакой специальный синтаксис для этого и не нужен: у нас есть `finally`, чего еще хотеть? Однако многословность такого подхода становится видна, если ресурсов несколько:

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

К тому же, неудобства доставляет то, что области видимости внутри блоков `try` и `finally` разные. Плюс, есть и место для неочевидных багов: всегда ли вы помнили о том, что в `finally` нужен знак `?`?

Новый синтаксис `using` делает использование ресурсов более удобным:

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

Обратите внимание на запись `await using file = await ...`. Первый `await` здесь указывает на асинхронное освобождение ресурсов: при выходе области видимости будет выполнен `await file[Symbol.asyncDispose]()`. Второй — на асинхронную инициализацию: это просто вызов асинхронной `openFile()`.

Давайте посмотрим, как можно реализовать такую обертку для уже существующего ресурса. В нашем примере это будет `fs.FileHandle`.

```javascript
// src/file.ts

import "disposablestack/auto";
import * as fs from "node:fs/promises";
import { Writable } from "node:stream";

// тип нашего ресурса — объединение AsyncDisposable и исходного fs.FileHandle
export interface DisposableFile extends fs.FileHandle, AsyncDisposable {
  // добавим также вспомогательную функцию, которая понадобится нам позже
  writableWebStream(options?: fs.CreateWriteStreamOptions): WritableStream;
}

export async function openFile(path: string, flags?: string | number): Promise<DisposableFile> {
  const file = await fs.open(path, flags);

  // добавим функции прямо в объект file с помощью Object.assign
  return Object.assign(file, {
    [Symbol.asyncDispose]: () => file.close(),

    writableWebStream: (options: fs.CreateWriteStreamOptions = { autoClose: false }) =>
      Writable.toWeb(file.createWriteStream(options)),
  });
}
```

Запустим наши тесты:

```bash
$ npm test | grep file
# Subtest: file
ok 2 - file
```

## "async-sync": мьютексы

Синтаксис `await using foo = await ...` может казаться не очень-то нужным повторением. Но на самом деле, несложно привести примеры ресурсов, у которых будут асинхронными только инициализация или только освобождение.

Как пример ресурса с асинхронной инициализацией, но синхронным освобождением приведу один из моих любимых применений паттерна RAII — мьютекс:

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
        // инициализация асинхронная - может понадобиться ожидание
        // освобождение синхронное - отправка сигнала другим ожидающим
        using guard = await mutex.acquire();

        // до конца области видимости guard - критическая секция

        const newValue = value + 1;
        await sleep(100);
        value = newValue;

        // закомментируйте строчку using guard, чтобы увидеть
        // классический пример состояния гонки
      }
    };

    await Promise.all([task(), task()]);

    assert.equal(value, 10);
  });
});
```

Реализован наш `Mutex` как асинхронная фабрика `Disposable`-объектов:

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

Что с тестами?

```bash
$ npm test | grep mutex
# Subtest: mutex-guard
ok 3 - mutex-guard
```

## "sync-async": очередь задач

Как пример объекта с синхронной инициализацией и асинхронным освобождением, рассмотрим очередь задач:

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

      // в конце области видимости ожидаем завершения всех задач в очереди
    }

    assert.equal(runningTaskCount, 0);
    assert.equal(maxRunningTaskCount, 2);
  });
});
```

Ее реализация не слишком интересная, за исключением одной детали, о которой поговорим позже:

<details><summary>Реализация очереди</summary>

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

Простые тесты проходят:

```bash
$ npm test | grep queue
# Subtest: task-queue
ok 4 - task-queue
```

## Используем все вместе: fetchCat

Для практики, напишем функцию `fetchCat()`, которая будет использовать все четыре определенных нами ресурса:

```javascript
// src/fetch-cat.ts

import { subscribe } from "./event-subscription.js";
import { openFile } from "./file.js";
import { Mutex } from "./mutex.js";
import { TaskQueue } from "./task-queue.js";

/**
 * Забрать GET-запросами данные со всех `urls` и склеить по порядку в файл `outPath`.
 * Порядок страниц в выходном файле не гарантируется.
 *
 * @param options.concurrency максимальное количество одновременных запросов
 * @param options.onError вызывается в случае ошибки при получении одного из urls
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

  // для ограничения concurrency воспользуемся очередью задач
  await using taskQueue = new TaskQueue({ concurrency });

  // подписку на событие тоже используем как ресурс
  using errorSubscription = subscribe(taskQueue, "error", onError);

  // синхронизируем запись в выходной файл мьютексом
  const outFileMutex = new Mutex();

  // файл будет закрыт в конце области видимости
  await using outFile = await openFile(outPath, "w");

  for (const url of urls) {
    taskQueue.push(async () => {
      // глобальный fetch() - еще одно недавнее нововведение Node.js
      // по интерфейсу он совместим с браузерным
      const response = await fetch(url);

      {
        using outFileGuard = await outFileMutex.acquire();

        // а еще можно использовать те же интерфейсы стримов, что и в браузере
        await response.body?.pipeTo(outFile.writableWebStream());
      }
    });
  }
}
```

Опишем точку входа, распарсив агрументы встроенным в Node.js парсером — еще одна недавняя фича!

<details><summary>Код main.ts</summary>

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

Зададим несколько URL для проверки в файле `urls.txt`, не забыв парочку «обманок» для проверки вывода ошибок:

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

Запустим, чтобы проверить:

```bash
$ npm run demo

> demo
> xargs npm run start -- -o ./cat.html < ./urls.txt


> start
> tsc && node --max-old-space-size=8 ./dist/main-incorrect.js -o ./cat.html https://habr.com/ru/companies/ruvds/articles/346442/comments/ https://habr.com/ru/articles/203048/comments/ https://asdfasdfasdfasdf https://habr.com/ru/articles/144758/comments/ https://habr.com/ru/companies/floor796/articles/673318/comments/ https://habr.com/ru/companies/skyeng/articles/487764/comments/ https://habr.com/ru/articles/177159/comments/ https://habr.com/ru/articles/124899/comments/ https://habr.com/ru/articles/149237/comments/ https://foobarfoobarfoobar https://habr.com/ru/articles/202304/comments/ https://habr.com/ru/articles/307822/comments/
```

Хм, странно. Скрипт не завершается, а выходной файл пустой. Похоже на баг.

## Неочевидный баг

Чтобы найти, в чем ошибка, рассмотрим код подробнее:

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

  // обратите внимание на порядок инициализации ресурсов
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

  // Здесь кончается область видимости у outFile и у taskQueue.
  // Освобождение ресурсов происходит в обратном порядке.
  // Получается, что outFile будет закрыт раньше, чем taskQueue закончится!
}
```

На самом деле, логическая ошибка не исправится, если просто переставить местами ресурсы. Она заключается в том, что время жизни `outFile` должно быть привязано не к текущей области видимости, а ко времени жизни задач в очереди. Файл должен быть закрыт не раньше, чем все задачи в очереди завершатся.

К сожалению, Node.js не позволяет замыканиям продлевать время жизни захваченных ими ресурсов. Придется связать их явно. Но все-таки не совсем вручную — для аггрерации ресурсов используем класс `AsyncDisposableStack` — еще одну часть пропозала:

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

  // Поле taskQueue.resources имеет тип AsyncDisposableStack.
  // Как часть контракта TaskQueue, оно освобождается в его dispose,
  // причем только после завершения всех задач.

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

  // К этой области видимости из ресурсов привязан только сам taskQueue.
  // При его освобождении сначала будут выполнены все задачи в очереди,
  // а потом освобожден весь стек taskQueue.resources.
  // Таким образом, файл будет корректно закрыт
}
```

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

Отлично! Все (настоящие) страницы были загружены, а посмотрев в `./cat.html`, можем убедиться, что загружены правильно и без гонок.

Классы `DisposableStack` и `AsyncDisposableStack` предназначены для аггрегации нескольких ресурсов в один. Как правило, любой `Disposable`-ресурс, если у него есть под-ресурсы, должен иметь свой `DisposableStack`, и освобождать его у себя в `dispose()`. С `AsyncDisposable` и `AsyncDisposableStack` — аналогично.

## `article[Symbol.dispose]()`

Идея специального синтаксиса для паттерна RAII не нова — он есть как минимум [в C#] и [в Python]. Сегодня мы рассмотрели его реализацию из будущих версий JavaScript и TypeScript. У нее есть свои ограничения и неочевидные моменты. Но, несмотря на них, я очень рад появлению такого синтаксиса — и, надеюсь, смог объяснить, почему.

[в C#]: https://learn.microsoft.com/en-us/dotnet/csharp/language-reference/proposals/csharp-8.0/using#using-declaration
[в Python]: https://docs.python.org/3/reference/compound_stmts.html#the-with-statement

Весь код доступен [в репозитории].

[в репозитории]: https://github.com/iliazeus/js-disposable-demo

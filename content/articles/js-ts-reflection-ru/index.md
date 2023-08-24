---
title: "Рефлексия в JavaScript и TypeScript: обзор основных техник. Как сгенерировать для класса CLI-интерфейс"
date: 2023-08-23
description: пишем свой декларативный CLI-фреймворк

extra:
  lang: ru
  links:
    - rel: license
      text: CC BY-SA 4.0
      href: https://creativecommons.org/licenses/by-sa/4.0/
    - rel: alternate
      text: habr
      href: https://habr.com/ru/articles/754764/
---

Как и в любом достаточно динамическом языке, в JavaScript из коробки есть способы разобрать в рантайме структуру его значений — определить типы, ключи объектов, получить конструкторы и прототипы.

В этой статье я хочу разобрать основные такие возможности, плюс показать, как можно получить еще больше информации о типах при использовании TypeScript, и как добавить классам и их полям собственные метаданные при помощи декораторов. Каждую из техник я покажу на примере небольшого CLI-фреймворка, работа с которым к концу статьи будет выглядеть как на картинке:

![итоговый CLI-фреймворк](cover.png)

Весь мой обзор рефлексии — и всю работу над фреймворком — я разделю на несколько уровней.

## Уровень 0: никакой рефлексии

Для начала напишем код вообще без какой-либо рефлексии — по факту, просто обертку для стандартного [`util.parseArgs`] из Node.js.

[`util.parseArgs`]: https://nodejs.org/docs/latest-v20.x/api/util.html#utilparseargsconfig

<details><summary>stage0/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export type Main = (
  args: string[],
  opts: Record<string, OptionValue>,
) => void | number | Promise<void | number>;

export type OptionValue =
  // опция не указана
  | undefined
  // опция-флаг, без значения
  | boolean
  // опция со значением
  | string
  // опция указана несколько раз
  | Array<boolean | string>;

export async function run(main: Main) {
  const { positionals: args, values: opts } = parseArgs({ strict: false });

  try {
    const code = await main(args, opts);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}
```

</details>

Использование такого недо-фреймворка выглядит так:

<details><summary>stage0/main.ts</summary>

```typescript
import { OptionValue, run } from "./framework.js";

await run(main);

function main(args: string[], opts: Record<string, OptionValue>) {
  // вручную реализуем короткие имена
  if (opts.verbose || opts.v) {
    console.debug(args);
    console.debug(opts);
  }

  // вручную разбираем команды
  const [command, ...commandArgs] = args;
  if (!command) {
    console.error("no command specified");
    return 1;
  }

  switch (command) {
    case "hello": {
      const [name] = commandArgs;
      if (!name) {
        console.error(`command required 1 argument, 0 given`);
        return 1;
      }

      // вручную проверяем типы значений опций
      const enthusiastic = opts.enthusiastic ?? opts.e ?? false;
      if (typeof enthusiastic !== "boolean") {
        console.error(`invalid type for --enthusiastic option`);
        return 1;
      }

      console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
      return 0;
    }

    default:
      console.error(`unknown command: ${command}`);
      return 1;
  }
}
```

</details>

Как хорошо видно из этого кода, пока что фреймворк не предоставляет почти никаких способов собственно задать CLI-интерфейс. Короткие имена опций, типы их значений, диспетчеризацию команд — все это пришлось реализовать вручную.

Это ограничение именно моего кода — самой `parseArgs` можно передать [описание CLI-интерфейса] с определениями всех опций. Но вместо того, чтобы указывать его в таком формате, я буду использовать во фреймворке рефлексию, позволя ему самому вывесит это описание.

[описание CLI-интерфейса]: https://nodejs.org/docs/latest-v20.x/api/util.html#utilparseargsconfig

Начну с основ.

## Уровень 1: основы JS-рефлексии

Эти техники настолько распространены, что применительно к JS их редко называют, собственно, рефлексией:

- [оператор `typeof`]: определение JS-типа значения

  [оператор `typeof`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof

  Выражение `typeof x` может вернуть `"undefined"`, `"boolean"`, `"number"`, `"bigint"`, `"string"`, `"object"`, `"function"`. Важно помнить, что по историческим причинам `typeof null === "object"`!

  Кроме того, для классов возвращается `"function"`, даже при условии, что просто как функцию их вызвать нельзя — только через `new`.

- [оператор `instanceof`]: определение, есть ли нужный прототип у объекта

  [оператор `instanceof`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/instanceof

  Если забыть про прототипное наследование и оперировать только классами, то `x instanceof A` вернет булево значение, показывающее, является ли `x` экземпляром `A` или его потомка.

- [оператор `in`]: проверка наличия ключа у объекта

  [оператор `in`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/in

  Выражения `"p" in x` проверяет, есть ли у объекта `x` ключ `p`. При этом `x` обязательно должен быть объектом, иначе будет выкинута `TypeError`.

- [функция `Object.keys()`] и [цикл `for...in`]: перечисление ключей объекта

  [функция `Object.keys()`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys
  [цикл `for...in`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for...in

  Этими способами можно перечислить ключи только тех свойств, которые являются [перечисляемыми (enumerable)]. Как правило, в эту категорию попадают почти все ключи, которые может понадобиться перечислить. Некоторые исключения покажу далее.

  [перечисляемыми (enumerable)]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Enumerability_and_ownership_of_properties

Давайте применим некоторые из них, чтобы сделать наш фреймворк чуть красивее. А именно: пусть теперь точка входа в программу будет задаваться классом, а его поля будут определять общие для всех команд опции:

<details><summary>stage1/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export interface Program {
  main(
    args: string[],
    opts: Record<string, OptionValue>,
  ): void | number | Promise<void | number>;
}

export type OptionValue =
  | undefined
  | boolean
  | string
  | Array<boolean | string>;

export async function run(Program: new () => Program) {
  const program = new Program();

  const { positionals: args, values: opts } = parseArgs({ strict: false });

  // по соглашению, все поля `program` - это общие для всех команд опции
  for (const k of Object.keys(program)) {
    if (k in opts) {
      // полностью типизировать функции, использующие рефлексию, довольно сложно
      // поэтому готовьтесь — в коде будут any
      (program as any)[k] = opts[k];
      delete opts[k];
    }
  }

  try {
    const code = await program.main(args, opts);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}
```

</details>

Код в `main.ts` теперь выглядит так:

<details><summary>stage1/main.ts</summary>

```typescript
import { OptionValue, run } from "./framework.js";

class Program {
  // если target слишком старый (меньше es2022),
  // то в нем не будет поддержки синтаксиса объявления полей
  // поэтому поля, которым не заданы значения, не будут присутствовать в объекте
  verbose: boolean | undefined = undefined;

  // для es2022 и новее можно писать просто:
  v: boolean | undefined;

  main(args: string[], opts: Record<string, OptionValue>) {
    // короткие имена все равно приходится обрабатывать самостоятельно
    const verbose = this.verbose ?? this.v ?? false;
    if (verbose) {
      console.debug(this);
      console.debug(args);
      console.debug(opts);
    }

    // команды разбираем все еще вручную
    const [command, ...commandArgs] = args;
    if (!command) {
      console.error("no command specified");
      return 1;
    }

    switch (command) {
      case "hello": {
        const [name] = commandArgs;
        if (!name) {
          console.error(`command required 1 argument, 0 given`);
          return 1;
        }

        // вручную проверяем типы значений опций
        const enthusiastic = opts.enthusiastic ?? opts.e ?? false;
        if (typeof enthusiastic !== "boolean") {
          console.error(`invalid type for --enthusiastic option`);
          return 1;
        }

        console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
        return 0;
      }

      default:
        console.error(`unknown command: ${command}`);
        return 1;
    }
  }
}

await run(Program);
```

</details>

Преимущества такого подхода пока что не слишком заметны: общие для команд опции мы определили, но сами команды все равно приходится диспатчить вручную. Но это легко исправить следующим уровнем рефлексии!

## Уровень 2: прототипы, перечисление методов

Расширим требования для `Program`: все его методы будут считаться отдельными командами.

Методы объекта в JS — это просто свойства его прототипа, у которых значения — это функции. Прототип объектов класса `A` доступен как [`A.prototype`].

[`A.prototype`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/prototype

Однако при использовании не прототипов напрямую, а классов, методы [объявляются не-перечисляемыми]. Поэтому просто сделать `Object.keys(Program.prototype)` или `for (k in Program.prototype)` не получится. На помощь приходит [`Object.getOwnPropertyNames()`], возвращающий _все_ ключи данного объекта.

[объявляются не-перечисляемыми]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/Method_definitions#method_definitions_in_classes
[`Object.getOwnPropertyNames()`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/getOwnPropertyNames

У этого метода есть еще одна особенность по сравнению с `Object.keys()`. На нее указывает `Own` в имени — она возвращает ключи, принадлежащие конкретно этому объекту, _не_ поднимаясь по цепочке прототипов — то есть, не возвращает унаследованные ключи. Если они все-таки нужны, нужно пройти по цепочке прототипов самим — примерно так:

```javascript
const allKeys = [];
for (let proto = A.prototype; proto; proto = Object.getPrototypeOf(proto)) {
  allKeys.push(...Object.getOwnPropertyNames(proto));
}
```

В нашем фреймворке для простоты положим, что командами могут быть только собственные методы класса `Program`, не унаследованные от предков. Так нам, к тому же, не придется беспокоится о том, что мы добавим как команды все методы общего для всех классов предка `Object`.

Важно также помнить, что `constructor` — это тоже ключ в прототипе любого класса. Его нужно будет отфильтровать.

<details><summary>stage2/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export type CommandFn = (
  args: string[],
  opts: Record<string, OptionValue>,
) => void | number | Promise<void | number>;

export type OptionValue =
  | undefined
  | boolean
  | string
  | Array<boolean | string>;

export async function run(Program: new () => any) {
  const program = new Program();

  const {
    positionals: [command, ...args],
    values: opts,
  } = parseArgs({ strict: false });

  const sharedOpts = Object.keys(program);

  for (const k of sharedOpts) {
    if (k in opts) {
      program[k] = opts[k];
      delete opts[k];
    }
  }

  // по соглашению, все методы `program` - это команды
  // методы класса не enumerable
  // поэтому нам нужна getOwnPropertyNames(), а не просто keys()
  const commands = Object.getOwnPropertyNames(Program.prototype).filter(
    (k) => typeof program[k] === "function" && k !== "constructor",
  );

  // валидируем команды на уровне фреймворка

  if (!command) {
    console.error("no command specified");
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  if (!commands.includes(command)) {
    console.error(`unknown command: ${command}`);
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  try {
    const code = await program[command]!(args, opts);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}
```

</details>

Теперь мы, наконец, можем убрать из `main.ts` код диспетчеризации команд:

<details><summary>stage2/main.ts</summary>

```typescript
import { OptionValue, run } from "./framework.js";

class Program {
  verbose: boolean | undefined;
  v: boolean | undefined;

  hello(args: string[], opts: Record<"e" | "enthusiastic", OptionValue>) {
    const verbose = this.verbose ?? this.v ?? false;
    if (verbose) {
      console.debug(this);
      console.debug(args);
      console.debug(opts);
    }

    const enthusiastic = opts.enthusiastic ?? opts.e ?? false;
    if (typeof enthusiastic !== "boolean") {
      console.error(`invalid type for --enthusiastic option`);
      return 1;
    }

    const [name] = args;
    if (!name) {
      console.error(`command required 1 argument, 0 given`);
      return 1;
    }

    console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
    return 0;
  }
}

await run(Program);
```

</details>

## Уровень 3: аргументы функций

Хорошо бы избавиться от необходимости разбирать массив `args` самим, и при этом заставить фреймворк сам проверять, что команде передано необходимое количество аргументов. Для этого немного поменяем интерфейс самих методов-команд: будем передавать аргументы не массивом, а как отдельные аргументы метода, при этом для удобства поставив `opts` на первое место:

```typescript
// Было:
hello(args: string[], opts: Record<string, OptionValue>): ...

// Стало:
hello(opts: Record<string, OptionValue>, name: string): ...
```

Теперь можно валидировать количество переданных CLI-команде аргументов на основе количества аргументов функции. Его можно получить для любой функции `f` при помощи [свойства `f.length`].

[свойства `f.length`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/length

Но есть одна хитрость. Свойство `f.length` на самом деле будет _минимальным необходимым_ числом аргументов, которое необходимо передать функции! Оно не учитывает случаи необязательных аргументов:

```javascript
// аргументы со значениями по умолчанию
function f1(a, b = null) {}
assert(f1.length === 1);

// rest-аргументы
function f2(a, ...bs) {}
assert(f2.length === 1);

// свойство arguments
function f3(a) {
  doWork(arguments[2]);
}
assert(f3.length === 1);

// плюс к этому, "лишние" аргументы просто игнорируются
function f4(a) {}
f4(1, 2, 3, 4, 5);
```

Учитывая это, реализуем валидацию минимального числа аргументов для команды:

<details><summary>stage3/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export type CommandFn = (
  opts: Record<string, OptionValue>,
  // rest-параметр удобнее всего оставить последним
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue =
  | undefined
  | boolean
  | string
  | Array<boolean | string>;

export async function run(Program: new () => any) {
  const program = new Program();

  const {
    positionals: [command, ...args],
    values: opts,
  } = parseArgs({ strict: false });

  const sharedOpts = Object.keys(program);

  for (const k of sharedOpts) {
    if (k in opts) {
      program[k] = opts[k];
      delete opts[k];
    }
  }

  // по соглашению, все методы `program` - это команды
  // методы класса не enumerable
  // поэтому нам нужна getOwnPropertyNames(), а не просто keys()
  const commands = Object.getOwnPropertyNames(Program.prototype).filter(
    (k) => typeof program[k] === "function" && k !== "constructor",
  );

  // валидируем команды на уровне фреймворка

  if (!command) {
    console.error("no command specified");
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  if (!commands.includes(command)) {
    console.error(`unknown command: ${command}`);
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  const commandFn: Function = program[command];

  // валидируем число аргументов функции
  // передать больше аргументов можно, меньше нет
  // +1 аргумент с опциями

  const minArgCount = commandFn.length - 1;

  if (args.length < minArgCount) {
    console.error(`too few arguments for command ${command}`);
    console.error(`at least ${minArgCount}, ${args.length} given`);

    process.exitCode = 1;
    return;
  }

  try {
    const code = await program[command]!(opts, ...args);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}
```

</details>

<details><summary>stage3/main.ts</summary>

```typescript
import { OptionValue, run } from "./framework.js";

class Program {
  verbose: boolean | undefined;
  v: boolean | undefined;

  hello(opts: Record<"e" | "enthusiastic", OptionValue>, name: string) {
    const verbose = this.verbose ?? this.v ?? false;
    if (verbose) {
      console.debug(this);
      console.debug([name]);
      console.debug(opts);
    }

    const enthusiastic = opts.enthusiastic ?? opts.e ?? false;
    if (typeof enthusiastic !== "boolean") {
      console.error(`invalid type for --enthusiastic option`);
      return 1;
    }

    console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
    return 0;
  }
}

await run(Program);
```

</details>

## Уровень 4: декораторы и Reflect.metadata

Чтобы фреймворк умел сам понимать, какое короткое имя есть у опции, нам нужна возможность навесить на соответствующее свойство класса метаданные, в которых будет и это короткое имя, и какие-то дополнительные свойства. Кроме того, если будем явно отмечать методы-команды и свойства-опции, то сможем иметь в классе `Program` и посторонние свойства и методы.

Проще и красивее всего это сделать, используя декораторы.

У [декораторов] в JS и TS тяжелая судьба. Пропозал несколько раз переделывали, и многие кодовые базы все еще завязаны на полифиллы одного из устаревших драфтов спецификации.

[декораторов]: https://github.com/tc39/proposal-decorators

В компиляторе TypeScript реализованы два варианта декораторов:

- финальный; доступен без дополнительных опций [начиная с TypeScript 5.0]
- на основе одного из черновиков; доступен [с опцией `experimentalDecorators`]

[начиная с TypeScript 5.0]: https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/#decorators
[с опцией `experimentalDecorators`]: https://www.typescriptlang.org/docs/handbook/decorators.html

Забегая вперед, скажу, что для более продвинутых уровней рефлексии в TS нам придется использовать именно `experimentalDecorators`. Но на текущем уровне мы можем совершенно абстрагироваться от этого выбора, используя библиотеку [`reflect-metadata`]:

[`reflect-metadata`]: https://www.npmjs.com/package/reflect-metadata

```typescript
import "reflect-metadata";
// теперь в глобальном объекте Reflect доступны новые методы

class Foo {
  // метод Reflect.metadata() можно сразу использовать в качестве декоратора
  @Reflect.metadata("meta-key", "value")
  f() {}
}

// но лучше будет завернуть его в отдельную функцию
const MyDecorator = (value) =>
  // в качестве ключа удобно использовать саму эту функцию
  Reflect.metadata(MyDecorator, value);

class Bar {
  @MyDecorator("value")
  prop: string;
}

// метаданные читать вот так:
const value1 = Reflect.getMetadata(Foo.prototype, "meta-key", "f");
const value2 = Reflect.getMetadata(Bar.prototype, MyDecorator, "prop");

// если не передать последний аргумент,
// вернутся метаданные, навешенные на сам класс, а не на его члены
```

Используя декораторы, `reflect-metadata` и обход ключей из предыдущих уровней, несложно реализовать нужную фичу:

<details><summary>stage4/framework.ts</summary>

```typescript
import "reflect-metadata";
import { parseArgs } from "node:util";

export interface OptionDefinition {
  short?: string;
}

// декораторы с помощью Reflect.metadata
// в качестве ключа метаданных удобно брать саму функцию-декоратор
export const Option = (def: OptionDefinition) => Reflect.metadata(Option, def);

// для лучшей типизации удобно сразу определить геттер
const getOptionMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Option, ctor.prototype, prop) as
    | OptionDefinition
    | undefined;

// даже если у декоратора на данный момент нет параметров,
// его удобно все равно сделать функцией
export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue =
  | undefined
  | boolean
  | string
  | Array<boolean | string>;

export async function run(Program: new () => any) {
  const program = new Program();

  const {
    positionals: [command, ...args],
    values: opts,
  } = parseArgs({ strict: false });

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    if (def.short && def.short in opts) {
      program[k] = opts[def.short];
      delete opts[def.short];
    }

    if (k in opts) {
      program[k] = opts[k];
      delete opts[k];
    }
  }

  const commands: string[] = [];

  for (const k of Object.getOwnPropertyNames(Program.prototype)) {
    const def = getCommandMetadata(Program, k);
    if (!def) continue;

    commands.push(k);
  }

  if (!command) {
    console.error("no command specified");
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  if (!commands.includes(command)) {
    console.error(`unknown command: ${command}`);
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  const commandFn: Function = program[command];
  const minArgCount = commandFn.length - 1;

  if (args.length < minArgCount) {
    console.error(`too few arguments for command ${command}`);
    console.error(`at least ${minArgCount}, ${args.length} given`);

    process.exitCode = 1;
    return;
  }

  try {
    const code = await program[command]!(opts, ...args);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}
```

</details>

Теперь код в `main.ts` выглядит так:

<details><summary>stage4/main.ts</summary>

```typescript
import { Command, Option, OptionValue, run } from "./framework.js";

class Program {
  // можно задать опции короткое имя
  @Option({ short: "v" })
  verbose = false;

  // теперь можно иметь поля, не являющиеся опциями
  version = "1.0.0";

  @Command()
  hello(opts: Record<"e" | "enthusiastic", OptionValue>, name: string) {
    if (this.verbose) {
      console.debug(this);
      console.debug([name]);
      console.debug(opts);
    }

    // опции конкретной команды пока что все равно нужно разбирать руками
    const enthusiastic = opts.enthusiastic ?? opts.e ?? false;
    if (typeof enthusiastic !== "boolean") {
      console.error(`invalid type for --enthusiastic option`);
      return 1;
    }

    console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
    return 0;
  }
}

await run(Program);
```

</details>

## Уровень 5: описание типов для рантайма

Неплохо бы в декоратор `@Option()` добавить также тип значения опции. Но стандартного способа описать тип значения в JS другим JS-значением, к сожалению, нет. Есть, конечно, то, что возвращает `typeof`, но этого недостаточно для сложных типов — объектов и массивов.

К счастью, есть ряд договоренностей и умолчаний, которые часто используются библиотеками и фреймворками для такой задачи. В частности, я буду ориентироваться на соглашения, которые [повсеместно] [используются] [в Nest.js]:

[повсеместно]: https://docs.nestjs.com/openapi/types-and-parameters#arrays
[используются]: https://docs.nestjs.com/techniques/mongodb#model-injection
[в Nest.js]: https://docs.nestjs.com/

```typescript
// примитивные типы представлены их "конструктором"
const number = Number;
const string = String;

// массивы представлены одноэлементными массивами
const arrayOfNumber = [Number];
const arrayOfString = [String];

// объекты представлены, кхм, объектами
const person = {
  name: String,
  age: Number,
};

// и их можно использовать в любых комбинациях
const dto = {
  people: [{ name: String, age: Number }],
};

// получается синтаксис, похожий на типы в TypeScript
type Dto = {
  people: { name: string; age: number }[];
};
```

В TypeScript при работе с таким рантайм-представлением типов важно не забывать, где оно, а где типы самого TypeScript. Если, к примеру, случайно объявить поле какого-то объекта как `Number` вместо `number`, то ошибка может выскочить в неожиданном месте — примитив [можно присвоить] к переменной, тип которой — его boxed-версия. Но не наоборот!

[можно присвоить]: https://www.typescriptlang.org/play#code/DYUwLgBAhgXBByBXAtgIxAJwgXggRgCYBmAbgChRJU4A7FdLXAFgFYA2csqHCVc1HlBJA

Давайте теперь используем такой синтаксис для типов, чтобы добавить в наш фреймворк проверку типов значений опций. Облегчит нам задачу то, что `parseArgs` поддерживает, фактически, только четыре типа: `boolean | string | boolean[] | string[]`:

<details><summary>stage5/framework.ts</summary>

```typescript
import "reflect-metadata";
import { ParseArgsConfig, parseArgs } from "node:util";

export interface OptionDefinition {
  short?: string;

  // такой синтаксис для обозначения типов в рантайме уже стал стандартом де-факто
  type: typeof String | typeof Boolean | [typeof String] | [typeof Boolean];
}

export const Option = (def: OptionDefinition) => Reflect.metadata(Option, def);

const getOptionMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Option, ctor.prototype, prop) as
    | OptionDefinition
    | undefined;

export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue =
  | undefined
  | boolean
  | string
  | Array<boolean | string>;

export async function run(Program: new () => any) {
  const program = new Program();

  const {
    positionals: [command, ...args],
    values: opts,
  } = parseArgs({
    strict: false,
    options: getOptionsConfigFromMetadata(Program, program),
  });

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    if (def.short && def.short in opts) {
      program[k] = opts[def.short];
      delete opts[def.short];
    }

    if (k in opts) {
      program[k] = opts[k];
      delete opts[k];
    }
  }

  const commands: string[] = [];

  for (const k of Object.getOwnPropertyNames(Program.prototype)) {
    const def = getCommandMetadata(Program, k);
    if (!def) continue;

    commands.push(k);
  }

  if (!command) {
    console.error("no command specified");
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  if (!commands.includes(command)) {
    console.error(`unknown command: ${command}`);
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  const commandFn: Function = program[command];
  const minArgCount = commandFn.length - 1;

  if (args.length < minArgCount) {
    console.error(`too few arguments for command ${command}`);
    console.error(`at least ${minArgCount}, ${args.length} given`);

    process.exitCode = 1;
    return;
  }

  try {
    const code = await program[command]!(opts, ...args);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}

// к сожалению, этот тип не экспортируется в более удобоваримом виде
type OptionsConfig = Exclude<ParseArgsConfig["options"], undefined>;

function getOptionsConfigFromMetadata(
  Program: new () => any,
  program: any,
): OptionsConfig {
  const config: OptionsConfig = {};

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    let short = def.short;
    let type: "string" | "boolean" = "string";
    let multiple = false;

    if (def.type === String) {
      type = "string";
      multiple = false;
    } else if (def.type === Boolean) {
      type = "boolean";
      multiple = false;
    } else if (Array.isArray(def.type)) {
      multiple = true;

      if (def.type[0] === String) {
        type = "string";
      } else if (def.type[0] === Boolean) {
        type = "boolean";
      }
    }

    config[k] = { short, type, multiple };
  }

  return config;
}
```

</details>

<details><summary>stage5/main.ts</summary>

```typescript
import { Command, Option, OptionValue, run } from "./framework.js";

class Program {
  @Option({ type: Boolean, short: "v" })
  verbose = false;

  version = "1.0.0";

  @Command()
  hello(opts: Record<"e" | "enthusiastic", OptionValue>, name: string) {
    if (this.verbose) {
      console.debug(this);
      console.debug([name]);
      console.debug(opts);
    }

    const enthusiastic = opts.enthusiastic ?? opts.e ?? false;
    if (typeof enthusiastic !== "boolean") {
      console.error(`invalid type for --enthusiastic option`);
      return 1;
    }

    console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
    return 0;
  }
}

await run(Program);
```

</details>

## Уровень 6: спрашиваем типы у самого TypeScript

При использовании TypeScript, есть возможность не изобретать синтаксис для описания типов в рантайме — фактически, дублируя их описания в TypeScript — а сказать компилятору сохранить информацию о типах в метаданные класса. Для этого потребуется:

- опция компилятора [`emitDecoratorMetadata`] — для сохранения метаданных
- опция компилятора [`experimentalDecorators`] — для работы первой опции
- библиотека [`reflect-metadata`] — для чтения сохраненных метаданных

[`emitDecoratorMetadata`]: https://www.typescriptlang.org/tsconfig#emitDecoratorMetadata
[`experimentalDecorators`]: https://www.typescriptlang.org/tsconfig#experimentalDecorators
[`reflect-metadata`]: https://www.npmjs.com/package/reflect-metadata

Нужны именно "старые" декораторы, а не новые стандартные. На данным момент, `emitDecoratorMetadata` _требует_ `experimentalDecorators`.

Метаданные сохраняются только для членов классов, причем только для тех, на которых уже висит хотя бы один декоратор. Конкретный интерфейс не описан в документации компилятора, но его можно понять, если [поэкспериментировать] с тем, во что компилируются различные выражения.

[поэкспериментировать]: https://www.typescriptlang.org/play?experimentalDecorators=true&emitDecoratorMetadata=true&target=9#code/CYUwxgNghgTiAEYD2A7AzgF3gWQJ4BFwkYoNiAueAMQFcUwMBLVAbgCg3Io01qkl4AbzbxR8AAJ5CyEmRgixoGaRDAACjCQAHAISVMMRigDm7BaLpLiK9Zt36Mhk2bESpRWcXPwrs1dhAMAAskYAAKADN+Sip+ABp4FEoUGgBbACMQGABKBydjIW9XOAwaGBR4ACJuYAjK9lcAXzZGoA

Самое важное, что о нем нужно знать заранее — он далеко не такой подробный, как хотелось бы. Фактически, для каждого типа сохраняется только его "конструктор", если это понятие к нему вообще применимо. То есть, для класса `Foo` будет сохранен `Foo`, для `number` будет сохранен `Number`, для `number[]` — `Array`, а для типа-литерала `{ name: string }` — просто `Object`. Обиднее всего за массивы: объекты хотя бы можно представить классами, но для массивов все равно придется оставить способ явно указывать тип их элементов.

Из-за этого, а также ради использования без TypeScript, этот способ получения информации о типах нельзя оставить как единственный. Тем не менее, реализовать его несложно, и некоторой тавтологии он позволяет избежать.

<details><summary>stage6/framework.ts</summary>

```typescript
import "reflect-metadata";
import { ParseArgsConfig, parseArgs } from "node:util";

export interface OptionDefinition {
  short?: string;
  type?: typeof String | typeof Boolean | [typeof String] | [typeof Boolean];
}

export const Option = (def: OptionDefinition) => Reflect.metadata(Option, def);

const getOptionMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Option, ctor.prototype, prop) as
    | OptionDefinition
    | undefined;

export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue =
  | undefined
  | boolean
  | string
  | Array<boolean | string>;

export async function run(Program: new () => any) {
  const program = new Program();

  const {
    positionals: [command, ...args],
    values: opts,
  } = parseArgs({
    strict: false,
    options: getOptionsConfigFromMetadata(Program, program),
  });

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    if (def.short && def.short in opts) {
      program[k] = opts[def.short];
      delete opts[def.short];
    }

    if (k in opts) {
      program[k] = opts[k];
      delete opts[k];
    }
  }

  const commands: string[] = [];

  for (const k of Object.getOwnPropertyNames(Program.prototype)) {
    const def = getCommandMetadata(Program, k);
    if (!def) continue;

    commands.push(k);
  }

  if (!command) {
    console.error("no command specified");
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  if (!commands.includes(command)) {
    console.error(`unknown command: ${command}`);
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  const commandFn: Function = program[command];
  const minArgCount = commandFn.length - 1;

  if (args.length < minArgCount) {
    console.error(`too few arguments for command ${command}`);
    console.error(`at least ${minArgCount}, ${args.length} given`);

    process.exitCode = 1;
    return;
  }

  try {
    const code = await program[command]!(opts, ...args);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}

type OptionsConfig = Exclude<ParseArgsConfig["options"], undefined>;

function getOptionsConfigFromMetadata(
  Program: new () => any,
  program: any,
): OptionsConfig {
  const config: OptionsConfig = {};

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    // получаем информацию из типов TypeScript
    const defType =
      def.type ?? Reflect.getMetadata("design:type", Program.prototype, k);

    let short = def.short;
    let type: "string" | "boolean" = "string";
    let multiple = false;

    if (defType === String) {
      type = "string";
      multiple = false;
    } else if (defType === Boolean) {
      type = "boolean";
      multiple = false;
    } else if (Array.isArray(defType)) {
      multiple = true;

      if (defType[0] === String) {
        type = "string";
      } else if (defType[0] === Boolean) {
        type = "boolean";
      }
    } else {
      throw new Error(`unable to determine option type for ${k}`);
    }

    config[k] = { short, type, multiple };
  }

  return config;
}
```

</details>

<details><summary>stage6/main.ts</summary>

```typescript
import { Command, Option, OptionValue, run } from "./framework.js";

class Program {
  // для правильной работы emitDecoratorMetadata
  // может понадобиться явно указать типы, даже если их можно вывести
  @Option({ short: "v" })
  verbose: boolean = false;

  version = "1.0.0";

  @Command()
  hello(opts: Record<"e" | "enthusiastic", OptionValue>, name: string) {
    if (this.verbose) {
      console.debug(this);
      console.debug([name]);
      console.debug(opts);
    }

    const enthusiastic = opts.enthusiastic ?? opts.e ?? false;
    if (typeof enthusiastic !== "boolean") {
      console.error(`invalid type for --enthusiastic option`);
      return 1;
    }

    console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
    return 0;
  }
}

await run(Program);
```

</details>

## Уровень 7: типы аргументов методов, DTO-классы

Тем же способом — с помощью `emitDecoratorMetadata` — можно узнать и типы аргументов функции. Воспользуемся этим, чтобы наконец-то позволить фреймворку самому выводить типы опций для отдельных команд.

Подвох, конечно, в том, что — как я писал выше — для типов-объектов метаданные сохранятся, только если этот тип — класс. Для того, чтобы обойти это ограничение, нужно объявлять типы-объекты именно как `class`, а не как `interface` или тип-литерал.

```typescript
// вместо этого:
interface IOptions {
  enthusiastic: boolean;
}

// объявлять так:
class Options {
  enthusiastic: boolean;
}

// можно продолжать использовать привычный синтаксис,
// система типов такое допускает
const opts1: Options = { enthusiastic: true };
const opts2: Options = JSON.parse(str);

// главное не забывать, что эти объекты не станут волшебным образом
// экземплярами класса Options
assert(!(opts1 instanceof Options));
```

Добавим этот последний штрих к нашему фреймворку, чтобы клиентскому коду уже совсем не нужно было разбирать опции руками:

<details><summary>stage7/framework.ts</summary>

```typescript
import "reflect-metadata";
import { ParseArgsConfig, parseArgs } from "node:util";

export interface OptionDefinition {
  short?: string;
  type?: typeof String | typeof Boolean | [typeof String] | [typeof Boolean];
}

export const Option = (def: OptionDefinition) => Reflect.metadata(Option, def);

const getOptionMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Option, ctor.prototype, prop) as
    | OptionDefinition
    | undefined;

export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue =
  | undefined
  | boolean
  | string
  | Array<boolean | string>;

export async function run(Program: new () => any) {
  const program = new Program();

  const {
    positionals: [command],
  } = parseArgs({
    strict: false,
    options: getOptionsConfigFromMetadata(Program, program),
  });

  const commands: string[] = [];

  for (const k of Object.getOwnPropertyNames(Program.prototype)) {
    const def = getCommandMetadata(Program, k);
    if (!def) continue;

    commands.push(k);
  }

  if (!command) {
    console.error("no command specified");
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  if (!commands.includes(command)) {
    console.error(`unknown command: ${command}`);
    console.error(`available commands: ${commands.join(", ")}`);

    process.exitCode = 1;
    return;
  }

  const OptsDto = Reflect.getMetadata(
    "design:paramtypes",
    Program.prototype,
    command,
  )?.[0];

  const optsDto = OptsDto ? new OptsDto() : undefined;

  const {
    positionals: [, ...args],
    values: opts,
  } = parseArgs({
    strict: false,
    options: {
      ...getOptionsConfigFromMetadata(Program, program),
      ...getOptionsConfigFromMetadata(OptsDto, optsDto),
    },
  });

  Object.assign(optsDto, opts);

  const commandFn: Function = program[command];
  const minArgCount = commandFn.length - 1;

  if (args.length < minArgCount) {
    console.error(`too few arguments for command ${command}`);
    console.error(`at least ${minArgCount}, ${args.length} given`);

    process.exitCode = 1;
    return;
  }

  try {
    const code = await program[command]!(optsDto, ...args);
    process.exitCode = code ?? 0;
  } catch (error: any) {
    process.exitCode = error.exitCode ?? 1;
    throw error;
  }
}

type OptionsConfig = Exclude<ParseArgsConfig["options"], undefined>;

function getOptionsConfigFromMetadata(
  Program: new () => any,
  program: any,
): OptionsConfig {
  const config: OptionsConfig = {};

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    // получаем информацию из типов TypeScript
    const defType =
      def.type ?? Reflect.getMetadata("design:type", Program.prototype, k);

    let short = def.short;
    let type: "string" | "boolean" = "string";
    let multiple = false;

    if (defType === String) {
      type = "string";
      multiple = false;
    } else if (defType === Boolean) {
      type = "boolean";
      multiple = false;
    } else if (Array.isArray(defType)) {
      multiple = true;

      if (defType[0] === String) {
        type = "string";
      } else if (defType[0] === Boolean) {
        type = "boolean";
      }
    } else {
      throw new Error(`unable to determine option type for ${k}`);
    }

    config[k] = { short, type, multiple };
  }

  return config;
}

function extractOptions(
  Dto: new () => any,
  dto: any,
  opts: Record<string, OptionValue>,
): void {
  for (const k of Object.keys(dto)) {
    const def = getOptionMetadata(Dto, k);
    if (!def) continue;

    if (def.short && def.short in opts) {
      dto[k] = opts[def.short];
      delete opts[def.short];
    }

    if (k in opts) {
      dto[k] = opts[k];
      delete opts[k];
    }
  }
}
```

</details>

Итоговый клиентский код из `main.ts`:

```typescript
import { Command, Option, run } from "./framework.js";

// можно даже отметить этот класс как abstract
class HelloOptions {
  @Option({ short: "e" })
  enthusiastic: boolean = false;
}

class Program {
  @Option({ short: "v" })
  verbose: boolean = false;

  version = "1.0.0";

  @Command()
  hello({ enthusiastic }: HelloOptions, name: string) {
    if (this.verbose) {
      console.debug(this);
      console.debug([name]);
      console.debug({ enthusiastic });
    }

    console.log(`Hello ${name}${enthusiastic ? "!" : "."}`);
    return 0;
  }
}

await run(Program);
```

## @Conclusion()

Как видно из финального кода, нам удалось упрятать внутрь нашего маленького фреймворка весь код, связанный с обработкой аргументов командной строки. Клиенту достаточно организовать свой код в классы, придерживаясь некоторых соглашений, а фреймворк уже сделает все сам.

Схожие механизмы рефлексии довольно широко применяются во многих TypeScript-фреймворках. Основным вдохновением для этой статьи был, конечно, [Nest.js]. Но я считаю, что — независимо от выбора фреймворка — знание этих механизмов может помочь проектировать более логичные, лаконичные и удобные API.

[Nest.js]: https://docs.nestjs.com/

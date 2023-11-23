---
title: "Reflection in JavaScript and TypeScript: writing a CLI framework"
date: 2023-11-23
description: an overview of main reflection techniques

extra:
  lang: en
  links:
    - rel: license
      text: CC BY-SA 4.0
      href: https://creativecommons.org/licenses/by-sa/4.0/
    - rel: alternate
      text: read in russian
      href: /articles/js-ts-reflection-ru/
---

Javascript, as most dynamically-typed languages, has a lot of ways to inspect its values at runtime - getting their types, querying object fields, constructors, prototypes, et cetera. In this article I will give an overview of such techniques, and then show how using TypeScript allows for even more powerful reflection using decorators and type metadata.

I will demonstrate all of those by writing a toy CLI framework. By the end, its API will look something like this:

![final CLI framework API](cover.png)

I will structure this whole thing with "levels", starting with:

## Level 0: no reflection

To start, let's try to write our toy CLI framework without using any reflection at all. It will basically be a simple wrapper over Node's [`util.parseArgs`].

[`util.parseArgs`]: https://nodejs.org/docs/latest-v20.x/api/util.html#utilparseargsconfig

<details><summary>stage0/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export type Main = (
  args: string[],
  opts: Record<string, OptionValue>
) => void | number | Promise<void | number>;

export type OptionValue =
  // option is not specified
  | undefined
  // a boolean option, without a value
  | boolean
  // an option that has a value
  | string
  // an option specified multiple times
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

Using it will look something like this:

<details><summary>stage0/main.ts</summary>

```typescript
import { OptionValue, run } from "./framework.js";

await run(main);

function main(args: string[], opts: Record<string, OptionValue>) {
  // have to manually implement short options
  if (opts.verbose || opts.v) {
    console.debug(args);
    console.debug(opts);
  }

  // have to manually parse commands
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

      // have to manually check option types
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

As you can see, this "framework" is extremely bare-bones. Short options, option value types, command dispatch - all of that has to be manually implemented. It's not a limitation of `parseArgs` - in fact, it accepts a detailed enough [CLI definition] that has most of those features. The thing I want to do, though, is to generate all that automatically, using reflection.

[CLI definition]: https://nodejs.org/docs/latest-v20.x/api/util.html#utilparseargsconfig

Anyway, let's start with the basics.

## Level 1: the basics of JS reflection

These things are basic enough that people usually don't event call them "reflection":

- [the `typeof` operator]: querying JS types of values

  [the `typeof` operator]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/typeof

  The `typeof x` expression returns one of `"undefined"`, `"boolean"`, `"number"`, `"bigint"`, `"string"`, `"object"`, or `"function"`. One caveat is: `typeof null === "object"`, for historical reasons. Additionaly, it returns `"function"` for class constructors, even though they can only be called with `"new"`, and not as plain functions.

- [the `instanceof` operator]: querying an object's prototype chain

  [the `instanceof` operator]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/instanceof

  Speaking in terms of class-based inheritance, `x instanceof A` returns `true` if `x` is an instance (duh) of `A` or any of its subclasses.

- [the `in` operator]: querying whether an object has a property

  [the `in` operator]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Operators/in

  The `"p" in x` experssion returns `true` if `x` has a property named `p`. Note that `x` has to be an object - else a `TypeError` is thrown.

- [the `Object.keys()` function] and [the `for...in` loop]: enumerating an object's properties

  [the `Object.keys()` function]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/keys
  [the `for...in` loop]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Statements/for...in

  Some of the properties might be non-[enumerable], thus not showing up when using `Object.keys()` or `for...in`. Most "regular" object properties are enumerable, and I'll cover some exceptions later.

  [enumerable]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Enumerability_and_ownership_of_properties

Let's apply some of the listed things to make our framework's API a little bit nicer. For example, let's make it so the program's entry point is a class, and its fields will represent command options:

<details><summary>stage1/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export interface Program {
  main(args: string[], opts: Record<string, OptionValue>): void | number | Promise<void | number>;
}

export type OptionValue = undefined | boolean | string | Array<boolean | string>;

export async function run(Program: new () => Program) {
  const program = new Program();

  const { positionals: args, values: opts } = parseArgs({ strict: false });

  // by convention, all the fields of `program` represent CLI options
  // right now, those are shared between all commands
  for (const k of Object.keys(program)) {
    if (k in opts) {
      // it's quite hard to write properly typed code when using reflection
      // so be prepared for some `any`s
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

The `main.ts` code now looks like this:

<details><summary>stage1/main.ts</summary>

```typescript
import { OptionValue, run } from "./framework.js";

class Program {
  // TypeScript's targets that are older than ES2022 won't have field definition syntax,
  // which means that uninitialized field will be missing from the class,
  // so I'm explicitly initializing this to `undefined`
  verbose: boolean | undefined = undefined;

  // with a target of ES2022 or newer, you can just do:
  v: boolean | undefined;

  main(args: string[], opts: Record<string, OptionValue>) {
    // still have to manually implement short options
    const verbose = this.verbose ?? this.v ?? false;
    if (verbose) {
      console.debug(this);
      console.debug(args);
      console.debug(opts);
    }

    // still have to manually dispatch commands
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

        // still have to manually chech option types
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

Well, it does not look that much nicer as of right now. Commands, for example, still have to be dispatched manually. But we'll fix that with the next level of reflection!

## Level 2: object prototypes, enumerating methods

Let's make it so any method of `Program` is treated as a separate command.

Insance methods in JavaScript are simply properties of its prototype, the values of which are functions. All objects of class `A` share the same prototype, which can be accessed as [`A.prototype`].

[`A.prototype`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/prototype

Thing is, though, that those prototype properties are [marked as non-enumerable], meaning we can't just use `Object.keys()` or a `for...in` loop. For that, there is the [`Object.getOwnPropertyNames()`] function. The `Own` in the name means that it will only return the keys of this exact object, not of its prototypes. Which means that in order to handle the methods of `Program`'s possible superclasses, we will have to walk the prototype chain ourselves - like this:

[marked as non-enumerable]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Functions/Method_definitions#method_definitions_in_classes
[`Object.getOwnPropertyNames()`]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Object/getOwnPropertyNames

```javascript
const allKeys = [];
for (let proto = A.prototype; proto; proto = Object.getPrototypeOf(proto)) {
  allKeys.push(...Object.getOwnPropertyNames(proto));
}
```

For our toy example, though, let's simply say that only `Program`'s own methods will be treated as commands. And let's also not forget to filter out `constructor` from the list of the prototype's properties.

<details><summary>stage2/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export type CommandFn = (
  args: string[],
  opts: Record<string, OptionValue>
) => void | number | Promise<void | number>;

export type OptionValue = undefined | boolean | string | Array<boolean | string>;

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

  // by convention, all `program`'s instance methods define separate commands
  // they are not enumerable, so we use getOwnPropertyNames() instead of keys()
  const commands = Object.getOwnPropertyNames(Program.prototype).filter(
    (k) => typeof program[k] === "function" && k !== "constructor"
  );

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

This allows us to finally get rid of command dispatch code in `main.ts`:

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

## Level 3: function arguments

It would be nice to not have to parse the `args` ourselves, but instead to force the framework to do that and to validate the number of arguments. For that, we'll change the interface of command methods a bit, passing `args` as separate arguments, and putting the `opts` as the first argument:

```typescript
// Before:
hello(args: string[], opts: Record<string, OptionValue>): ...

// After:
hello(opts: Record<string, OptionValue>, name: string): ...
```

This allows us to validate the number of CLI arguments based on the number of command functions' arguments - which can be queried by using the [`f.length` property].

[`f.length` property]: https://developer.mozilla.org/en-US/docs/Web/JavaScript/Reference/Global_Objects/Function/length

There is a caveat, though. The `f.length` property is, in fact, a _minimum required_ number of arguments! It does not count any optional arguments:

```javascript
// arguments with a default value
function f1(a, b = null) {}
assert(f1.length === 1);

// rest-arguments
function f2(a, ...bs) {}
assert(f2.length === 1);

// the `arguments` property
function f3(a) {
  doWork(arguments[2]);
}
assert(f3.length === 1);

// and the "extra" arguments at call site
function f4(a) {}
f4(1, 2, 3, 4, 5);
```

Being mindful of that, let's implement the validation of the _minimum_ number of CLI arguments;

<details><summary>stage3/framework.ts</summary>

```typescript
import { parseArgs } from "node:util";

export type CommandFn = (
  opts: Record<string, OptionValue>,
  // passing `args` as separate arguments
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue = undefined | boolean | string | Array<boolean | string>;

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

  // by convention, all `program`'s instance methods define separate commands
  // they are not enumerable, so we use getOwnPropertyNames() instead of keys()
  const commands = Object.getOwnPropertyNames(Program.prototype).filter(
    (k) => typeof program[k] === "function" && k !== "constructor"
  );

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

  // the -1 is here because of the `opts` argument

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

## Level 4: decorators and `Reflect.metadata`

To make our framework understand short options, we need a way to specify those short names as additional metadata beside the option field, possibly with some extra option metadata. It will also allow us to explicitly mark option fields and command methods, allowing `Program` to have fields and options that aren't part of the CLI.

The most convenient way to do that is to use decorators. In TypeScript, there actuall are two decorator implementations:

- the now-ECMAScript-standard one, available by default [since TypeScript 5.0]
- the one based on a previous draft, available using [the `experimentalDecorators` option]

[since TypeScript 5.0]: https://devblogs.microsoft.com/typescript/announcing-typescript-5-0/#decorators
[the `experimentalDecorators` option]: https://www.typescriptlang.org/docs/handbook/decorators.html

For one of the further reflection levels, we'll in fact have to use the "older" implementation. But for now, we can abstract those away completely using the [`reflect-metadata`] library:

[`reflect-metadata`]: https://www.npmjs.com/package/reflect-metadata

```typescript
import "reflect-metadata";
// the global Reflect object now has some new methods

class Foo {
  // you can use Reflect.metadata() itself as a decorator
  @Reflect.metadata("meta-key", "value")
  f() {}
}

// but it's better to wrap it into a function
const MyDecorator = (value) =>
  // you can use this same function as a metadata key
  Reflect.metadata(MyDecorator, value);

class Bar {
  @MyDecorator("value")
  prop: string;
}

// accessing the metadata
const value1 = Reflect.getMetadata(Foo.prototype, "meta-key", "f");
const value2 = Reflect.getMetadata(Bar.prototype, MyDecorator, "prop");

// if called without the last argument, it returns the metadata for the class itself,
// rather than its members
```

Let's implement the short options feature with decorators and `reflect-metadata`:

<details><summary>stage4/framework.ts</summary>

```typescript
import "reflect-metadata";
import { parseArgs } from "node:util";

export interface OptionDefinition {
  short?: string;
}

// a Reflect.metadata-based decorator
// you can use the function itself as metadata key
export const Option = (def: OptionDefinition) => Reflect.metadata(Option, def);

// for convenience, let's also define a getter
const getOptionMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Option, ctor.prototype, prop) as OptionDefinition | undefined;

// even if the decorator has no arguments,
// it's more convenient to wrap it in a function anyway
export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue = undefined | boolean | string | Array<boolean | string>;

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

The `main.ts` now looks like this:

<details><summary>stage4/main.ts</summary>

```typescript
import { Command, Option, OptionValue, run } from "./framework.js";

class Program {
  // specifying short options with a decorator
  @Option({ short: "v" })
  verbose = false;

  // no @Option() decorator means this is not an option
  version = "1.0.0";

  @Command()
  hello(opts: Record<"e" | "enthusiastic", OptionValue>, name: string) {
    if (this.verbose) {
      console.debug(this);
      console.debug([name]);
      console.debug(opts);
    }

    // for now, command-specific options still have to be handled manually
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

## Level 5: runtime type descriptors

The next logical step is for the `@Option()` decorator to also specify the type of the option's value. Thing is, JavaScript doesn't have a built-in way of representing types at runtime. There are the `typeof` values, of course - but they aren't really useful for arrays and objects, as they don't specify the types of elements and members.

To combat that, there are a few common conventions. For example, [Nest.js], among others, [often] [uses] these:

[Nest.js]: https://docs.nestjs.com/
[often]: https://docs.nestjs.com/openapi/types-and-parameters#arrays
[uses]: https://docs.nestjs.com/techniques/mongodb#model-injection

```typescript
// primitive types are represented by their "constructors"
const number = Number;
const string = String;

// arrays are representet by one-element arrays
const arrayOfNumber = [Number];
const arrayOfString = [String];

// objects are represented by, well, objects
const person = {
  name: String,
  age: Number,
};

// you can combine those in any way you like
const dto = {
  people: [{ name: String, age: Number }],
};

// it often resembles actual TypeScript type definitions
type Dto = {
  people: { name: string; age: number }[];
};
```

It is important to distinguish between these and the actual TypeScript types. For example, defining a field in a TypeScript interface as `Number` instead of `number` can lead to a non-obvious errors - a primitive type [can be assigned] to a boxed type variable, but not the other way around!

[can be assigned]: https://www.typescriptlang.org/play#code/DYUwLgBAhgXBByBXAtgIxAJwgXggRgCYBmAbgChRJU4A7FdLXAFgFYA2csqHCVc1HlBJA

Let's now use this "type descriptor" syntax to specify the types for our CLI options. We don't even have to implement the whole type hierarchy - `parseArgs` only supports `boolean`, `string`, `boolean[]` and `string[]`:

<details><summary>stage5/framework.ts</summary>

```typescript
import "reflect-metadata";
import { ParseArgsConfig, parseArgs } from "node:util";

export interface OptionDefinition {
  short?: string;
  type: typeof String | typeof Boolean | [typeof String] | [typeof Boolean];
}

export const Option = (def: OptionDefinition) => Reflect.metadata(Option, def);

const getOptionMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Option, ctor.prototype, prop) as OptionDefinition | undefined;

export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue = undefined | boolean | string | Array<boolean | string>;

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

// idk why, but this type isn't exported properly
type OptionsConfig = Exclude<ParseArgsConfig["options"], undefined>;

function getOptionsConfigFromMetadata(Program: new () => any, program: any): OptionsConfig {
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

## Level 6: making TypeScript do the work

When using TypeScript, it is possible to make it embed some type information into class member metadata. For that, we'll need:

- to enable the [`emitDecoratorMetadata`] compiler option;
- to enable "older" [`experimentalDecorators`];
- to use our old friend [`reflect-metadata`].

[`emitDecoratorMetadata`]: https://www.typescriptlang.org/tsconfig#emitDecoratorMetadata
[`experimentalDecorators`]: https://www.typescriptlang.org/tsconfig#experimentalDecorators
[`reflect-metadata`]: https://www.npmjs.com/package/reflect-metadata

We need those older decorators specifically - the now-standard ones, sadly, won't work.

The type metadata is only saved for class members, and only for those that have at least one decorator attached to them. The metadata format isn't well documented, but we can get an idea bu just [messing around] on the TS Playground.

[messing around]: https://www.typescriptlang.org/play?experimentalDecorators=true&emitDecoratorMetadata=true&target=9#code/CYUwxgNghgTiAEYD2A7AzgF3gWQJ4BFwkYoNiAueAMQFcUwMBLVAbgCg3Io01qkl4AbzbxR8AAJ5CyEmRgixoGaRDAACjCQAHAISVMMRigDm7BaLpLiK9Zt36Mhk2bESpRWcXPwrs1dhAMAAskYAAKADN+Sip+ABp4FEoUGgBbACMQGABKBydjIW9XOAwaGBR4ACJuYAjK9lcAXzZGoA

Sadly, the metadata isn't as detailed as I'd want it to be. In essence, each type is represented by its "constructor" function - `Number` for `number`, `Boolean` for `boolean`, et cetera. That means that any object type (that is not a class itself) is just `Object` and any array is just `Array` - without any info on the type of elements or members.

All this means that TypeScript's type metadata is not enough to be the _only_ source of type info for our options. But it _would_ make the API nicer if we implement it as a possibility:

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
  Reflect.getMetadata(Option, ctor.prototype, prop) as OptionDefinition | undefined;

export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue = undefined | boolean | string | Array<boolean | string>;

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

function getOptionsConfigFromMetadata(Program: new () => any, program: any): OptionsConfig {
  const config: OptionsConfig = {};

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    // getting the TypeScript type metadata
    const defType = def.type ?? Reflect.getMetadata("design:type", Program.prototype, k);

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
  // you might have to specify the types explicitly for emitDecoratorMetadata to work
  // even in cases where they are inferred correctly by the compiler
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

## Level 7: method argument types and DTO classes

The same `emitDecoratorMetadata` feature will allow us to query types of class method arguments. We'll use that to finally get rid of the need to manually validate per-command options.

But to overcome the metadata limitations, we'll need to introduce DTO classes for those options:

```typescript
// instead of this:
interface IOptions {
  enthusiastic: boolean;
}

// we'll need this:
class Options {
  enthusiastic: boolean;
}

// you can still use object literals with such types
const opts1: Options = { enthusiastic: true };
const opts2: Options = JSON.parse(str);

// but remember that they won't magically become instances of Options!
assert(!(opts1 instanceof Options));
```

Let's add this final feature to our framework.

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
  Reflect.getMetadata(Option, ctor.prototype, prop) as OptionDefinition | undefined;

export const Command = () => Reflect.metadata(Command, {});

const getCommandMetadata = (ctor: new () => any, prop: string) =>
  Reflect.getMetadata(Command, ctor.prototype, prop) as {} | undefined;

export type CommandFn = (
  opts: Record<string, OptionValue>,
  ...args: string[]
) => void | number | Promise<void | number>;

export type OptionValue = undefined | boolean | string | Array<boolean | string>;

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

  const OptsDto = Reflect.getMetadata("design:paramtypes", Program.prototype, command)?.[0];

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

function getOptionsConfigFromMetadata(Program: new () => any, program: any): OptionsConfig {
  const config: OptionsConfig = {};

  for (const k of Object.keys(program)) {
    const def = getOptionMetadata(Program, k);
    if (!def) continue;

    const defType = def.type ?? Reflect.getMetadata("design:type", Program.prototype, k);

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

function extractOptions(Dto: new () => any, dto: any, opts: Record<string, OptionValue>): void {
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

This is how our final API looks like in `main.ts`:

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

As this last bit of code (hopefully) demonstrates, reflection is a very powerful tool for designing nice-to-use APIs. A lot of TypeScript frameworks use those - [Nest.js] being my primary inspiration. I hope this brief overview of reflection techniques was helpful!

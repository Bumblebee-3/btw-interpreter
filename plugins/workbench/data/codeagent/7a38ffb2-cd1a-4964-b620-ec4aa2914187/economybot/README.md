# Project Overview

This repository contains a **Node.js** utility library that provides a set of helpful functions for working with strings, arrays, and objects. The library is written in plain JavaScript using **CommonJS** modules, making it compatible with any Node.js environment (>= 12) and bundlers that support the CommonJS format.

The goal of the project is to:

- Offer a lightweight, zero‑dependency toolbox.
- Provide clear, well‑documented APIs.
- Enable easy integration into both backend services and CLI tools.

---

## Prerequisites

| Tool            | Minimum Version |
|-----------------|-----------------|
| Node.js         | 12.x            |
| npm (or yarn)   | 6.x             |
| Git (optional)  | —               |

---

## Setup & Installation

# Clone the repository (optional if you are installing from npm)
git clone https://github.com/your-username/your-project.git
cd your-project

# Install dependencies
npm install

> **Note:** This project has no runtime dependencies; `npm install` only creates the `node_modules` folder for development tools (e.g., testing, linting).

---

## Available Commands

| Command                | Description                                   |
|------------------------|-----------------------------------------------|
| `npm run build`        | Transpile source (if needed) – placeholder for future builds |
| `npm test`             | Run the test suite with **Mocha**              |
| `npm run lint`         | Run **ESLint** to check code style             |
| `npm run format`       | Auto‑format files with **Prettier**            |
| `npm start`            | Execute the example script (`node examples/index.js`) |

---

## Usage

### Importing the Library

All modules are exported using **CommonJS** syntax (`module.exports`). You can import the whole library or individual utilities.

```js
// Load the entire toolbox
const toolbox = require('./src'); // path may vary if installed as a package

// Load a single utility
const { capitalize } = require('./src/string'); // ./src/string.js
```

### Example: Capitalizing a String

```js
// examples/capitalize.js
// ---------------------------------------------------
// Demonstrates how to use the `capitalize` helper.
// ---------------------------------------------------

// Load only the needed function (CommonJS)
const { capitalize } = require('../src/string'); // Adjust path as needed

// Example input
const raw = 'hello world';

// Use the utility
const result = capitalize(raw);

// Output the result
console.log(`Original: ${raw}`);
console.log(`Capitalized: ${result}`); // => "Hello world"
```

Run the example with:

```bash
node examples/capitalize.js
```

### Example: Merging Objects

```js
// examples/mergeObjects.js
// ---------------------------------------------------
// Shows how to merge two objects using `deepMerge`.
// ---------------------------------------------------

const { deepMerge } = require('../src/object');

const defaults = { host: 'localhost', port: 3000, options: { timeout: 5000 } };
const overrides = { port: 8080, options: { secure: true } };

const merged = deepMerge(defaults, overrides);

console.log('Merged configuration:', merged);
// Output:
// {
//   host: 'localhost',
//   port: 8080,
//   options: { timeout: 5000, secure: true }
// }
```

Run it:

```bash
node examples/mergeObjects.js
```

---

## Testing

The test suite lives under the `test/` directory and uses **Mocha** + **Chai**.

```bash
npm test
```

You should see output similar to:

```
> mocha

  String utilities
    ✓ capitalize should uppercase first letter
    ✓ camelCase should convert strings correctly

  Array utilities
    ✓ chunk should split arrays into sized groups

  ...

  12 passing (45ms)
```

---

## Linting & Formatting

```bash
# Lint the source files
npm run lint

# Auto‑format with Prettier
npm run format
```

Both commands will target `src/**/*.js`, `test/**/*.js`, and `examples/**/*.js`.

---

## Contributing

1. Fork the repository.
2. Create a feature branch (`git checkout -b feat/your-feature`).
3. Implement your changes and add tests.
4. Ensure all linting and tests pass.
5. Open a Pull Request describing your changes.

Please follow the existing code style and include inline comments where appropriate.

---

## License

This project is licensed under the **MIT License**. See the `LICENSE` file for details.
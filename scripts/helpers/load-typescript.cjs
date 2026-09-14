const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const root = path.resolve(__dirname, "../..");
const ts = require(path.join(root, "node_modules/typescript"));

module.exports = function createLoader(stubs, globals = {}) {
  const modules = new Map();
  const load = (relative) => {
    const file = path.isAbsolute(relative)
      ? relative
      : path.join(root, relative);
    if (modules.has(file)) return modules.get(file);
    const exports = {};
    modules.set(file, exports);
    const code = ts.transpileModule(fs.readFileSync(file, "utf8"), {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        jsx: ts.JsxEmit.ReactJSX,
      },
    }).outputText;
    vm.runInNewContext(code, {
      exports,
      console,
      setTimeout,
      clearTimeout,
      Date,
      Map,
      Set,
      Promise,
      require: (id) => {
        if (Object.hasOwn(stubs, id)) return stubs[id];
        const base = id.startsWith("@/")
          ? path.join(root, "src", id.slice(2))
          : path.resolve(path.dirname(file), id);
        return load(base + ".ts");
      },
      ...globals,
    });
    return exports;
  };
  return load;
};

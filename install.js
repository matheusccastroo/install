makeInstaller = function (options) {
  "use strict";

  options = options || {};

  // These file extensions will be appended to required module identifiers
  // if they do not exactly match an installed module.
  var defaultExtensions = options.extensions || [".js", ".json"];

  // If defined, the options.onInstall function will be called any time
  // new modules are installed.
  var onInstall = options.onInstall;

  // If defined, each module-specific require function will be passed to
  // this function, along with the module.id of the parent module, and
  // the result will be used in place of the original require function.
  var wrapRequire = options.wrapRequire;

  // If defined, the options.override function will be called before
  // looking up any top-level package identifiers in node_modules
  // directories. It can either return a string to provide an alternate
  // package identifier, or a non-string value to prevent the lookup from
  // proceeding.
  var override = options.override;

  // If defined, the options.fallback function will be called when no
  // installed module is found for a required module identifier. Often
  // options.fallback will be implemented in terms of the native Node
  // require function, which has the ability to load binary modules.
  var fallback = options.fallback;

  // List of fields to look for in package.json files to determine the
  // main entry module of the package. The first field listed here whose
  // value is a string will be used to resolve the entry module.
  var mainFields = options.mainFields ||
    // If options.mainFields is absent and options.browser is truthy,
    // package resolution will prefer the "browser" field of package.json
    // files to the "main" field. Note that this only supports
    // string-valued "browser" fields for now, though in the future it
    // might make sense to support the object version, a la browserify.
    (options.browser ? ["browser", "main"] : ["main"]);

  // Called below as hasOwn.call(obj, key).
  var hasOwn = {}.hasOwnProperty;

  // Cache for looking up File objects given absolute module identifiers.
  // Invariants:
  //   filesByModuleId[module.id] === fileAppendId(root, module.id)
  //   filesByModuleId[module.id].module === module
  var filesByModuleId = {};

  // The file object representing the root directory of the installed
  // module tree.
  var root = new File("/", new File("/.."));
  var rootRequire = makeRequire(root);

  // Merges the given tree of directories and module factory functions
  // into the tree of installed modules and returns a require function
  // that behaves as if called from a module in the root directory.
  function install(tree, options) {
    if (isObject(tree)) {
      fileMergeContents(root, tree, options);
      if (isFunction(onInstall)) {
        onInstall(rootRequire);
      }
    }
    return rootRequire;
  }

  // Replace this function to enable Module.prototype.prefetch.
  install.fetch = function (ids) {
    throw new Error("fetch not implemented");
  };

  // This constructor will be used to instantiate the module objects
  // passed to module factory functions (i.e. the third argument after
  // require and exports), and is exposed as install.Module in case the
  // caller of makeInstaller wishes to modify Module.prototype.
  function Module(id) {
    this.id = id;

    // The Node implementation of module.children unfortunately includes
    // only those child modules that were imported for the first time by
    // this parent module (i.e., child.parent === this).
    this.children = [];

    // This object is an install.js extension that includes all child
    // modules imported by this module, even if this module is not the
    // first to import them.
    this.childrenById = {};
  }

  Module.prototype.resolve = function (id) {
    return this.require.resolve(id);
  };

  Module.prototype.prefetch = function (id) {
    var parentFile = getOwn(filesByModuleId, this.id);
    var missing = {};

    function walk(module) {
      var file = getOwn(filesByModuleId, module.id);
      if (fileIsDynamic(file) && ! file.pending) {
        file.pending = true;
        missing[file.module.id] = file.options;
        each(file.deps, function (parentId, id) {
          fileResolve(file, id, file.module);
        });
        each(file.module.childrenById, walk);
      }
    }

    var childFile = fileResolve(parentFile, id, parentFile.module);
    if (! childFile) {
      return Promise.reject(makeMissingError(id));
    }

    each(parentFile.module.childrenById, walk);

    // The install.fetch function takes an object mapping missing dynamic
    // module identifiers to options objects, and should return a Promise
    // that resolves to a module tree that can be installed.
    return Promise.resolve(install.fetch(missing))
      .then(install)
      .then(function () {
        // If everything was successful, the final result of the
        // module.prefetch(id) promise will be the fully-resolved absolute
        // form of the given identifier.
        return childFile.module.id;
      });
  };

  install.Module = Module;

  function getOwn(obj, key) {
    return hasOwn.call(obj, key) && obj[key];
  }

  function isObject(value) {
    return typeof value === "object" && value !== null;
  }

  function isFunction(value) {
    return typeof value === "function";
  }

  function isString(value) {
    return typeof value === "string";
  }

  function makeMissingError(id) {
    return new Error("Cannot find module '" + id + "'");
  }

  function makeRequire(file) {
    function require(id) {
      var result = fileResolve(file, id);
      if (result) {
        return fileEvaluate(result, file.module);
      }

      var error = makeMissingError(id);

      if (isFunction(fallback)) {
        return fallback(
          id, // The missing module identifier.
          file.module.id, // The path of the requiring file.
          error // The error we would have thrown.
        );
      }

      throw error;
    }

    if (isFunction(wrapRequire)) {
      require = wrapRequire(require, file.module.id);
    }

    require.extensions = fileGetExtensions(file).slice(0);

    require.resolve = function (id) {
      var f = fileResolve(file, id);
      if (f) return f.module.id;
      var error = makeMissingError(id);
      if (fallback && isFunction(fallback.resolve)) {
        return fallback.resolve(id, file.module.id, error);
      }
      throw error;
    };

    return require;
  }

  // File objects represent either directories or modules that have been
  // installed. When a `File` respresents a directory, its `.contents`
  // property is an object containing the names of the files (or
  // directories) that it contains. When a `File` represents a module, its
  // `.contents` property is a function that can be invoked with the
  // appropriate `(require, exports, module)` arguments to evaluate the
  // module. If the `.contents` property is a string, that string will be
  // resolved as a module identifier, and the exports of the resulting
  // module will provide the exports of the original file. The `.parent`
  // property of a File is either a directory `File` or `null`. Note that
  // a child may claim another `File` as its parent even if the parent
  // does not have an entry for that child in its `.contents` object.
  // This is important for implementing anonymous files, and preventing
  // child modules from using `../relative/identifier` syntax to examine
  // unrelated modules.
  function File(moduleId, parent) {
    var file = this;

    // Link to the parent file.
    file.parent = parent = parent || null;

    // The module object for this File, which will eventually boast an
    // .exports property when/if the file is evaluated.
    file.module = new Module(moduleId);
    filesByModuleId[moduleId] = file;

    // The .contents of the file can be either (1) an object, if the file
    // represents a directory containing other files; (2) a factory
    // function, if the file represents a module that can be imported; (3)
    // a string, if the file is an alias for another file; or (4) null, if
    // the file's contents are not (yet) available.
    file.contents = null;

    // Set of module identifiers imported by this module. Note that this
    // set is not necessarily complete, so don't rely on it unless you
    // know what you're doing.
    file.deps = {};
  }

  function fileEvaluate(file, parentModule) {
    var contents = file && file.contents;

    if (! contents && file.stub) {
      // If this file was installed with array notation, and the array
      // contained one or more objects but no functions, then the combined
      // properties of the objects are treated as a temporary stub for
      // file.module.exports. This is particularly important for partial
      // package.json modules, so that the resolution logic can know the
      // value of the "main" and/or "browser" fields, at least, even if
      // the rest of the package.json file is not (yet) available.
      return file.stub;
    }

    var module = file.module;

    if (! hasOwn.call(module, "exports")) {
      if (parentModule) {
        module.parent = parentModule;
        var children = parentModule.children;
        if (Array.isArray(children)) {
          children.push(module);
        }
      }

      // If a Module.prototype.useNode method is defined, give it a chance
      // to define module.exports based on module.id using Node.
      if (! isFunction(module.useNode) ||
          ! module.useNode()) {
        contents(
          module.require = module.require || makeRequire(file),
          // If the file had a .stub, reuse the same object for exports.
          module.exports = file.stub || {},
          module,
          file.module.id,
          file.parent.module.id
        );
      }

      module.loaded = true;
    }

    if (isFunction(module.runModuleSetters)) {
      module.runModuleSetters();
    }

    return module.exports;
  }

  function fileIsDirectory(file) {
    return file && isObject(file.contents);
  }

  function fileIsDynamic(file) {
    return file && file.contents === null;
  }

  function fileMergeContents(file, contents, options) {
    if (Array.isArray(contents)) {
      contents.forEach(function (item) {
        if (isString(item)) {
          file.deps[item] = file.module.id;
        } else if (isFunction(item)) {
          contents = item;
        } else if (isObject(item)) {
          file.stub = file.stub || {};
          each(item, function (value, key) {
            file.stub[key] = value;
          });
        }
      });

      if (! isFunction(contents)) {
        // If the array did not contain a function, merge nothing.
        contents = null;
      }

    } else if (! isFunction(contents) &&
               ! isString(contents) &&
               ! isObject(contents)) {
      // If contents is neither an array nor a function nor a string nor
      // an object, just give up and merge nothing.
      contents = null;
    }

    if (contents) {
      file.contents = file.contents || (isObject(contents) ? {} : contents);
      if (isObject(contents) && fileIsDirectory(file)) {
        each(contents, function (value, key) {
          if (key === "..") {
            child = file.parent;

          } else {
            var child = getOwn(file.contents, key);
            if (! child) {
              child = file.contents[key] = new File(
                file.module.id.replace(/\/*$/, "/") + key,
                file
              );

              child.options = options;
            }
          }

          fileMergeContents(child, value, options);
        });
      }
    }
  }

  function each(obj, callback, context) {
    Object.keys(obj).forEach(function (key) {
      callback.call(this, obj[key], key);
    }, context);
  }

  function fileGetExtensions(file) {
    return file.options
      && file.options.extensions
      || defaultExtensions;
  }

  function fileAppendIdPart(file, part, extensions) {
    // Always append relative to a directory.
    while (file && ! fileIsDirectory(file)) {
      file = file.parent;
    }

    if (! file || ! part || part === ".") {
      return file;
    }

    if (part === "..") {
      return file.parent;
    }

    var exactChild = getOwn(file.contents, part);

    // Only consider multiple file extensions if this part is the last
    // part of a module identifier and not equal to `.` or `..`, and there
    // was no exact match or the exact match was a directory.
    if (extensions && (! exactChild || fileIsDirectory(exactChild))) {
      for (var e = 0; e < extensions.length; ++e) {
        var child = getOwn(file.contents, part + extensions[e]);
        if (child && ! fileIsDirectory(child)) {
          return child;
        }
      }
    }

    return exactChild;
  }

  function fileAppendId(file, id, extensions) {
    var parts = id.split("/");

    // Use `Array.prototype.every` to terminate iteration early if
    // `fileAppendIdPart` returns a falsy value.
    parts.every(function (part, i) {
      return file = i < parts.length - 1
        ? fileAppendIdPart(file, part)
        : fileAppendIdPart(file, part, extensions);
    });

    return file;
  }

  function recordChild(parentModule, childFile) {
    var childModule = childFile && childFile.module;
    if (parentModule && childModule) {
      parentModule.childrenById[childModule.id] = childModule;
    }
  }

  function fileResolve(file, id, parentModule, seenDirFiles) {
    var parentModule = parentModule || file.module;
    var extensions = fileGetExtensions(file);

    file =
      // Absolute module identifiers (i.e. those that begin with a `/`
      // character) are interpreted relative to the root directory, which
      // is a slight deviation from Node, which has access to the entire
      // file system.
      id.charAt(0) === "/" ? fileAppendId(root, id, extensions) :
      // Relative module identifiers are interpreted relative to the
      // current file, naturally.
      id.charAt(0) === "." ? fileAppendId(file, id, extensions) :
      // Top-level module identifiers are interpreted as referring to
      // packages in `node_modules` directories.
      nodeModulesLookup(file, id, extensions);

    // If the identifier resolves to a directory, we use the same logic as
    // Node to find an `index.js` or `package.json` file to evaluate.
    while (fileIsDirectory(file)) {
      seenDirFiles = seenDirFiles || [];

      // If the "main" field of a `package.json` file resolves to a
      // directory we've already considered, then we should not attempt to
      // read the same `package.json` file again. Using an array as a set
      // is acceptable here because the number of directories to consider
      // is rarely greater than 1 or 2. Also, using indexOf allows us to
      // store File objects instead of strings.
      if (seenDirFiles.indexOf(file) < 0) {
        seenDirFiles.push(file);

        var pkgJsonFile = fileAppendIdPart(file, "package.json"), main;
        var pkg = pkgJsonFile && fileEvaluate(pkgJsonFile, parentModule);
        if (pkg &&
            mainFields.some(function (name) {
              return isString(main = pkg[name]);
            })) {
          recordChild(parentModule, pkgJsonFile);

          // The "main" field of package.json does not have to begin with
          // ./ to be considered relative, so first we try simply
          // appending it to the directory path before falling back to a
          // full fileResolve, which might return a package from a
          // node_modules directory.
          file = fileAppendId(file, main, extensions) ||
            fileResolve(file, main, parentModule, seenDirFiles);

          if (file) {
            // The fileAppendId call above may have returned a directory,
            // so continue the loop to make sure we resolve it to a
            // non-directory file.
            continue;
          }
        }
      }

      // If we didn't find a `package.json` file, or it didn't have a
      // resolvable `.main` property, the only possibility left to
      // consider is that this directory contains an `index.js` module.
      // This assignment almost always terminates the while loop, because
      // there's very little chance `fileIsDirectory(file)` will be true
      // for the result of `fileAppendIdPart(file, "index.js")`. However,
      // in principle it is remotely possible that a file called
      // `index.js` could be a directory instead of a file.
      file = fileAppendIdPart(file, "index.js");
    }

    if (file && isString(file.contents)) {
      file = fileResolve(file, file.contents, parentModule, seenDirFiles);
    }

    recordChild(parentModule, file);

    return file;
  };

  function nodeModulesLookup(file, id, extensions) {
    if (isFunction(override)) {
      id = override(id, file.module.id);
    }

    if (isString(id)) {
      for (var resolved; file && ! resolved; file = file.parent) {
        resolved = fileIsDirectory(file) &&
          fileAppendId(file, "node_modules/" + id, extensions);
      }

      return resolved;
    }
  }

  return install;
};

if (typeof exports === "object") {
  exports.makeInstaller = makeInstaller;
}

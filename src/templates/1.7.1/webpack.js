const path = require("path");
const fs = require("fs");
const webpack = require("webpack");
const CertStore = require("@microsoft/gulp-core-build-serve/lib/CertificateStore");
const CertificateStore = CertStore.CertificateStore || CertStore.default;
const ForkTsCheckerWebpackPlugin = require("fork-ts-checker-webpack-plugin");
const del = require("del");
const webpackMerge = require("webpack-merge");
const extend = require("./webpack.extend");
let RestProxy;

const settings = require("./config.json");
const rootFolder = path.resolve(__dirname, "../");

const port = settings.cli.isLibraryComponent ? 4320 : 4321;
const host = "https://localhost:" + port;
if (settings.cli.useRestProxy) {
  RestProxy = require('sp-rest-proxy');
}

///
// Transforms define("<guid>", ...) to web part specific define("<web part id_version", ...)
// the same approach is used inside copyAssets SPFx build step
///
class DynamicLibraryPlugin {
  constructor(options) {
    this.opitons = options;
  }

  apply(compiler) {
    compiler.hooks.emit.tap("DynamicLibraryPlugin", compilation => {
      for (const assetId in this.opitons.modulesMap) {
        const moduleMap = this.opitons.modulesMap[assetId];

        if (compilation.assets[assetId]) {
          const rawValue = compilation.assets[assetId].children[0]._value;
          compilation.assets[assetId].children[0]._value = rawValue.replace(this.opitons.libraryName, moduleMap.id + "_" + moduleMap.version);
        }
      }
    });
  }
}

///
// Removes *.module.scss.ts on the first execution in order prevent conflicts with *.module.scss.d.ts
// generated by css-modules-typescript-loader
///
class ClearCssModuleDefinitionsPlugin {
  constructor(options) {
    this.options = options || {};
  }

  apply(compiler) {
    compiler.hooks.done.tap("FixStylesPlugin", stats => {
      if (!this.options.deleted) {

        setTimeout(() => {
          del.sync(["src/**/*.module.scss.ts"], { cwd: rootFolder });
        }, 3000);

        this.options.deleted = true;
      }
    });
  }
}

let baseConfig = {
  target: "web",
  mode: "development",
  devtool: "source-map",
  resolve: {
    extensions: [".ts", ".tsx", ".js"],
    modules: ["node_modules"]
  },
  context: rootFolder,
  module: {
    rules: [
      {
        test: /\.tsx?$/,
        loader: "ts-loader",
        options: {
          transpileOnly: true
        },
        exclude: /node_modules/
      },
      {
        use: [{
          loader: "@microsoft/loader-cased-file",
          options: {
            name: "[name:lower]_[hash].[ext]"
          }
        }],
        test: /\.(jpe?g|png|woff|eot|ttf|svg|gif|dds)$/i
      },
      {
        use: [{
          loader: "html-loader"
        }],
        test: /\.html$/
      },
      {
        test: /\.css$/,
        use: [
          {
            loader: "@microsoft/loader-load-themed-styles",
            options: {
              async: true
            }
          },
          {
            loader: "css-loader"
          }
        ]
      },
      {
        test: function (fileName) {
          return fileName.endsWith(".module.scss");   // scss modules support
        },
        use: [
          {
            loader: "@microsoft/loader-load-themed-styles",
            options: {
              async: true
            }
          },
          "css-modules-typescript-loader",
          {
            loader: "css-loader",
            options: {
              modules: {
                localIdentName: "[local]_[hash:base64:8]"
              }
            }
          }, // translates CSS into CommonJS
          "sass-loader" // compiles Sass to CSS, using Node Sass by default
        ]
      },
      {
        test: function (fileName) {
          return !fileName.endsWith(".module.scss") && fileName.endsWith(".scss");  // just regular .scss
        },
        use: [
          {
            loader: "@microsoft/loader-load-themed-styles",
            options: {
              async: true
            }
          },
          "css-loader", // translates CSS into CommonJS
          "sass-loader" // compiles Sass to CSS, using Node Sass by default
        ]
      }
    ]
  },
  plugins: [
    new ForkTsCheckerWebpackPlugin({
      tslint: true
    }),
    new ClearCssModuleDefinitionsPlugin(),
    new webpack.DefinePlugin({
      "process.env.NODE_ENV": JSON.stringify(process.env.NODE_ENV),
      "process.env.DEBUG": JSON.stringify(true),
      "DEBUG": JSON.stringify(true)
    })],
  devServer: {
    hot: false,
    contentBase: rootFolder,
    publicPath: host + "/dist/",
    host: "localhost",
    port: port,
    disableHostCheck: true,
    historyApiFallback: true,
    open: settings.serve.open,
    writeToDisk: settings.cli.isLibraryComponent,
    openPage: settings.serve.openUrl ? settings.serve.openUrl : host + "/temp/workbench.html",
    stats: {
      preset: "errors-only",
      colors: true,
      chunks: false,
      modules: false,
      assets: false
    },
    proxy: { // url re-write for resources to be served directly from src folder
      "/lib/**/loc/*.js": {
        target: host,
        pathRewrite: { "^/lib": "/src" },
        secure: false
      }
    },
    headers: {
      "Access-Control-Allow-Origin": "*",
    },
    https: {
      cert: CertificateStore.instance.certificateData,
      key: CertificateStore.instance.keyData
    }
  },
}

if (settings.cli.useRestProxy) {
  baseConfig.devServer.before = function (app) {
    new RestProxy({
      port,
      logLevel: "Off"
    }, app).serveProxy();
  }
}

const createConfig = function () {
  // remove old css module TypeScript definitions
  del.sync(["dist/*.js", "dist/*.map"], { cwd: rootFolder });

  // we need only "externals", "output" and "entry" from the original webpack config
  let originalWebpackConfig = require("../temp/_webpack_config.json");
  baseConfig.externals = originalWebpackConfig.externals;
  baseConfig.output = originalWebpackConfig.output;

  baseConfig.entry = getEntryPoints(originalWebpackConfig.entry);

  baseConfig.output.publicPath = host + "/dist/";

  const manifest = require("../temp/manifests.json");
  const modulesMap = {};
  const originalEntries = Object.keys(originalWebpackConfig.entry);

  for (const jsModule of manifest) {
    if (jsModule.loaderConfig
      && jsModule.loaderConfig.entryModuleId
      && originalEntries.indexOf(jsModule.loaderConfig.entryModuleId) !== -1) {
      modulesMap[jsModule.loaderConfig.entryModuleId + ".js"] = {
        id: jsModule.id,
        version: jsModule.version
      }
    }
  }

  baseConfig.plugins.push(new DynamicLibraryPlugin({
    modulesMap: modulesMap,
    libraryName: originalWebpackConfig.output.library
  }));

  return baseConfig;
}

function getEntryPoints(entry) {
  // fix: ".js" entry needs to be ".ts"
  // also replaces the path form /lib/* to /src/*
  let newEntry = {};
  let libSearchRegexp;
  if (path.sep === "/") {
    libSearchRegexp = /\/lib\//gi;
  } else {
    libSearchRegexp = /\\lib\\/gi;
  }

  const srcPathToReplace = path.sep + "src" + path.sep;

  for (const key in entry) {
    let entryPath = entry[key];
    if (entryPath.indexOf("bundle-entries") === -1) {
      entryPath = entryPath.replace(libSearchRegexp, srcPathToReplace).slice(0, -3) + ".ts";
    } else {
      // replace paths and extensions in bundle file
      let bundleContent = fs.readFileSync(entryPath).toString();
      bundleContent = bundleContent.replace(libSearchRegexp, srcPathToReplace).replace(/\.js/gi, ".ts");
      fs.writeFileSync(entryPath, bundleContent);
    }
    newEntry[key] = entryPath;
  }

  return newEntry;
}

module.exports = webpackMerge(extend.transformConfig(createConfig()), extend.webpackConfig);

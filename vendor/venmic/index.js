"use strict";

/* Loader for the venmic native addon compiled from source (see README:
 * the npm package's prebuilt binary is deleted and the addon rebuilt with
 * cmake-js, then copied here). Vendoring the .node directly keeps venmic's
 * build tooling (cmake-js and friends) out of the shipped artifact —
 * the packaged app contains no npm packages at all. */

module.exports = require("./venmic-addon.node");

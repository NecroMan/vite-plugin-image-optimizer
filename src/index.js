import { basename, extname, join, sep } from 'pathe';
// eslint-disable-next-line import/no-unresolved
import { filename } from 'pathe/utils';
import fs from 'fs-extra';
import chalk from 'chalk';
import { optimize } from 'svgo';
import sharp from 'sharp';
import { merge, readAllFiles } from './utils';
import { VITE_PLUGIN_NAME, DEFAULT_OPTIONS } from './constants';

export default function (optionsParam = {}) {
  const options = merge(optionsParam, DEFAULT_OPTIONS);

  let rootConfig, outputPath, publicDir;

  const sizesMap = new Map();
  const mtimeCache = new Map();

  const applySVGO = async (filePath, buffer) => {
    return Buffer.from(
      optimize(buffer, {
        path: filePath,
        ...options.svg,
      }).data
    );
  };

  const applySharp = async (filePath, buffer) => {
    const extName = extname(filePath).replace('.', '');
    return await sharp(buffer, { animated: extName === 'gif' })
      .toFormat(extName, options[extName.toLowerCase()])
      .toBuffer();
  };

  const processFile = async (filePath, buffer) => {
    try {
      const engine = /\.svg$/.test(filePath) ? applySVGO : applySharp;
      const newBuffer = await engine(filePath, buffer);

      const newSize = newBuffer.byteLength;
      const oldSize = buffer.byteLength;
      const skipWrite = newSize >= oldSize;
      // save the sizes of the old and new image
      sizesMap.set(filePath, {
        size: newSize / 1024,
        oldSize: oldSize / 1024,
        ratio: Math.floor(100 * (newSize / oldSize - 1)),
        skipWrite,
      });

      return { content: newBuffer, skipWrite };
    } catch (error) {
      rootConfig.logger.error(`'${filePath}' - failed optimization`);
      return {};
    }
  };

  return {
    name: VITE_PLUGIN_NAME,
    enforce: 'post',
    apply: 'build',
    configResolved(c) {
      rootConfig = c;
      outputPath = c.build.outDir;
      if (typeof c.publicDir === 'string') {
        publicDir = c.publicDir;
      }
    },
    generateBundle: async (_, bundler) => {
      const files = [];
      const allFiles = Object.keys(bundler);
      if (options.include) {
        // include takes higher priority than `test` and `exclude`
        allFiles.forEach(filePath => {
          const fileName = bundler[filePath].name;
          if (isIncludedFile(fileName, options.include)) {
            files.push(filePath);
          }
        });
      } else {
        allFiles.forEach(filePath => {
          if (options.test.test(filePath)) {
            const fileName = bundler[filePath].name;
            if (!isExcludedFile(fileName, options.exclude)) {
              files.push(filePath);
            }
          }
        });
      }

      if (files.length > 0) {
        const handles = files.map(async filePath => {
          const source = bundler[filePath].source;
          const { content, skipWrite } = await processFile(filePath, source);
          if (content?.length > 0 && !skipWrite) {
            bundler[filePath].source = content;
          }
        });
        await Promise.all(handles).catch(e => rootConfig.logger.error(e));
      }
    },
    async closeBundle() {
      if (publicDir && options.includePublic) {
        const files = [];
        // find static images in the original static folder
        const allFiles = readAllFiles(publicDir);
        if (options.include) {
          // include takes higher priority than `test` and `exclude`
          allFiles.forEach(filePath => {
            const fileName = filename(filePath) + extname(filePath);
            if (isIncludedFile(fileName, options.include)) {
              files.push(filePath);
            }
          });
        } else {
          allFiles.forEach(filePath => {
            if (options.test.test(filePath)) {
              const fileName = filename(filePath) + extname(filePath);
              if (!isExcludedFile(fileName, options.exclude)) {
                files.push(filePath);
              }
            }
          });
        }

        if (files.length > 0) {
          const handles = files.map(async publicFilePath => {
            // convert the path to the output folder
            const filePath = publicFilePath.replace(publicDir + sep, '');
            const fullFilePath = join(outputPath, filePath);

            if (fs.existsSync(fullFilePath) === false) {
              return;
            }
            const { mtimeMs } = await fs.stat(fullFilePath);
            if (mtimeMs <= (mtimeCache.get(filePath) || 0)) {
              return;
            }

            const buffer = await fs.readFile(fullFilePath);
            const { content, skipWrite } = await processFile(filePath, buffer);
            if (content?.length > 0 && !skipWrite) {
              await fs.writeFile(fullFilePath, content);
              mtimeCache.set(filePath, Date.now());
            }
          });
          await Promise.all(handles).catch(e => rootConfig.logger.error(e));
        }
      }
      if (options.logStats) {
        logOptimizationStats(rootConfig, sizesMap);
      }
    },
  };
}

function isIncludedFile(fileName, include) {
  return checkFileMatch(fileName, include);
}

function isExcludedFile(fileName, exclude) {
  return checkFileMatch(fileName, exclude);
}

function checkFileMatch(fileName, matcher) {
  const isString = Object.prototype.toString.call(matcher) === '[object String]';
  const isRegex = Object.prototype.toString.call(matcher) === '[object RegExp]';
  const isArray = Array.isArray(matcher);
  if (isString) {
    return fileName === matcher;
  }
  if (isRegex) {
    return matcher.test(fileName);
  }
  if (isArray) {
    return matcher.includes(fileName);
  }
  return false;
}

function logOptimizationStats(rootConfig, sizesMap) {
  rootConfig.logger.info(
    `\n${chalk.cyan('✨ [vite-plugin-image-optimizer]')} - optimized image resources successfully: `
  );

  const keyLengths = Array.from(sizesMap.keys(), name => name.length);
  const valueLengths = Array.from(sizesMap.values(), value => `${Math.floor(100 * value.ratio)}`.length);

  const maxKeyLength = Math.max(...keyLengths);
  const valueKeyLength = Math.max(...valueLengths);
  sizesMap.forEach((value, name) => {
    const { size, oldSize, ratio, skipWrite } = value;

    const percentChange = ratio > 0 ? chalk.red(`+${ratio}%`) : ratio <= 0 ? chalk.green(`${ratio}%`) : '';

    rootConfig.logger.info(
      chalk.dim(basename(rootConfig.build.outDir)) +
        '/' +
        chalk.blueBright(name) +
        ' '.repeat(2 + maxKeyLength - name.length) +
        chalk.gray(`${percentChange} ${' '.repeat(valueKeyLength - `${ratio}`.length)}`) +
        ' ' +
        chalk.dim(
          skipWrite
            ? `${chalk.yellow.bold('skipped')} original: ${oldSize.toFixed(2)}kb <= optimized: ${size.toFixed(2)}kb`
            : `${oldSize.toFixed(2)}kb -> ${size.toFixed(2)}kb`
        )
    );
  });
  rootConfig.logger.info('\n');
}
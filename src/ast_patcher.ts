import { parse } from '@babel/parser';
import traverseImport from '@babel/traverse';
import generateImport from '@babel/generator';
import * as t from '@babel/types';
import { readFile, writeFile } from 'fs/promises';

// Handle default exports for CommonJS modules
const traverse = (traverseImport as any).default || traverseImport;
const generate = (generateImport as any).default || generateImport;

/**
 * AST Patch 配置接口
 */
export interface AstPatchConfig {
  // 要移除的函数名或变量名列表
  removeIdentifiers?: string[];
  // 变量/函数重命名映射 { 原名称: 新名称 }
  renameIdentifiers?: Record<string, string>;
  // 要移除的函数调用（按函数名）
  removeFunctionCalls?: string[];
  // 替换函数体 { 函数名: 返回值 }
  replaceFunctionBody?: Record<string, string>;
}

/**
 * 对 JavaScript 代码进行 AST patch
 * @param code 原始 JavaScript 代码
 * @param config Patch 配置
 * @returns 处理后的代码
 */
export function patchAst(code: string, config: AstPatchConfig): string {
  try {
    // 在代码前面插入认证检查逻辑（使用 CommonJS 格式的立即执行函数）
    const authCheckCode = `(function(){const{existsSync:e}=require('fs'),{join:j}=require('path'),{homedir:h}=require('os');const a=j(h(),'.factory','auth.json');if(!e(a)&&!process.env.FACTORY_API_KEY)process.env.FACTORY_API_KEY='sk-offline';})();`;

    // 将认证检查代码添加到原始代码前面
    const codeWithAuth = authCheckCode + code;

    // 解析代码为 AST
    const ast = parse(codeWithAuth, {
      sourceType: 'unambiguous',
      plugins: ['typescript', 'jsx'],
      errorRecovery: true,
      allowReturnOutsideFunction: true,
      allowAwaitOutsideFunction: true,
      allowUndeclaredExports: true,
      allowSuperOutsideMethod: true
    });

    // 遍历并修改 AST
    traverse(ast, {
      // 将 import 语句转换为 require 调用
      ImportDeclaration(path: any) {
        const source = path.node.source.value;
        const specifiers = path.node.specifiers;

        if (specifiers.length === 0) {
          // import "module" -> require("module")
          const requireCall = t.expressionStatement(
            t.callExpression(t.identifier('require'), [t.stringLiteral(source)])
          );
          path.replaceWith(requireCall);
          return;
        }

        // import * as name from "module" -> var name = require("module")
        if (specifiers.length === 1 && t.isImportNamespaceSpecifier(specifiers[0])) {
          const localName = specifiers[0].local.name;
          const requireCall = t.variableDeclaration('var', [
            t.variableDeclarator(
              t.identifier(localName),
              t.callExpression(t.identifier('require'), [t.stringLiteral(source)])
            )
          ]);
          path.replaceWith(requireCall);
          return;
        }

        // import { a, b } from "module" -> var { a, b } = require("module")
        if (specifiers.every((s: any) => t.isImportSpecifier(s))) {
          const properties = specifiers.map((spec: any) => {
            return t.objectProperty(
              t.identifier(spec.imported.name),
              t.identifier(spec.local.name),
              false,
              spec.imported.name === spec.local.name
            );
          });
          const requireCall = t.variableDeclaration('var', [
            t.variableDeclarator(
              t.objectPattern(properties),
              t.callExpression(t.identifier('require'), [t.stringLiteral(source)])
            )
          ]);
          path.replaceWith(requireCall);
          return;
        }

        // import name from "module" -> var name = require("module")
        // 注意：不添加 .default，因为很多模块（特别是 Node.js 内置模块）不使用 ES 模块格式
        if (specifiers.length === 1 && t.isImportDefaultSpecifier(specifiers[0])) {
          const localName = specifiers[0].local.name;
          const requireCall = t.variableDeclaration('var', [
            t.variableDeclarator(
              t.identifier(localName),
              t.callExpression(t.identifier('require'), [t.stringLiteral(source)])
            )
          ]);
          path.replaceWith(requireCall);
          return;
        }

        // 混合导入: import name, { a, b } from "module"
        // -> var _temp = require("module"), name = _temp, { a, b } = _temp
        const defaultSpec = specifiers.find((s: any) => t.isImportDefaultSpecifier(s));
        const namedSpecs = specifiers.filter((s: any) => t.isImportSpecifier(s));

        if (defaultSpec || namedSpecs.length > 0) {
          const tempId = path.scope.generateUidIdentifier('temp');
          const declarations = [];

          // var _temp = require("module")
          declarations.push(
            t.variableDeclarator(
              tempId,
              t.callExpression(t.identifier('require'), [t.stringLiteral(source)])
            )
          );

          // name = _temp (不使用 .default)
          if (defaultSpec) {
            declarations.push(
              t.variableDeclarator(
                t.identifier(defaultSpec.local.name),
                tempId
              )
            );
          }

          // { a, b } = _temp
          if (namedSpecs.length > 0) {
            const properties = namedSpecs.map((spec: any) => {
              return t.objectProperty(
                t.identifier(spec.imported.name),
                t.identifier(spec.local.name),
                false,
                spec.imported.name === spec.local.name
              );
            });
            declarations.push(
              t.variableDeclarator(t.objectPattern(properties), tempId)
            );
          }

          const requireCall = t.variableDeclaration('var', declarations);
          path.replaceWith(requireCall);
        }
      },

      // 替换 import.meta.require 和 import.meta.url
      MemberExpression(path: any) {
        // 检查是否是 import.meta.xxx
        if (
          t.isMetaProperty(path.node.object) &&
          path.node.object.meta.name === 'import' &&
          path.node.object.property.name === 'meta' &&
          t.isIdentifier(path.node.property)
        ) {
          const propertyName = path.node.property.name;

          // import.meta.require -> require
          if (propertyName === 'require') {
            console.log('替换 import.meta.require 为 require');
            path.replaceWith(t.identifier('require'));
          }
          // import.meta.url -> require('url').pathToFileURL(__filename).href
          else if (propertyName === 'url') {
            console.log('替换 import.meta.url 为 CommonJS 等价代码');
            path.replaceWith(
              t.memberExpression(
                t.callExpression(
                  t.memberExpression(
                    t.callExpression(t.identifier('require'), [t.stringLiteral('url')]),
                    t.identifier('pathToFileURL')
                  ),
                  [t.identifier('__filename')]
                ),
                t.identifier('href')
              )
            );
          }
        }
      },

      // 处理所有标识符（变量名、函数名等）
      Identifier(path: any) {
        const name = path.node.name;

        // 重命名标识符（只在绑定位置修改，避免破坏引用）
        if (config.renameIdentifiers && config.renameIdentifiers[name] && path.isBindingIdentifier()) {
          const newName = config.renameIdentifiers[name];
          if (typeof newName === 'string') {
            path.node.name = newName;
          }
        }
      },

      // 处理函数声明（移除或替换函数体）
      FunctionDeclaration(path: any) {
        const funcName = path.node.id?.name;
        if (!funcName) return;

        // 移除特定的函数声明
        if (config.removeIdentifiers && config.removeIdentifiers.includes(funcName)) {
          console.log(`移除函数声明: ${funcName}`);
          path.remove();
          return;
        }

        // 替换函数体
        if (config.replaceFunctionBody) {
          const returnValue = config.replaceFunctionBody[funcName];
          if (returnValue && typeof returnValue === 'string') {
            console.log(`替换函数 ${funcName} 的函数体，返回: ${returnValue}`);

            // 创建新的函数体：return "返回值";
            const newBody = t.blockStatement([
              t.returnStatement(t.stringLiteral(returnValue))
            ]);

            path.node.body = newBody;
          }
        }
      },

      // 处理箭头函数和函数表达式
      VariableDeclarator(path: any) {
        if (config.removeIdentifiers) {
          const varName = t.isIdentifier(path.node.id) ? path.node.id.name : null;
          if (varName && config.removeIdentifiers.includes(varName)) {
            console.log(`移除变量声明: ${varName}`);
            // 如果是声明语句中的唯一变量，移除整个声明语句
            const parent = path.parentPath;
            if (parent.isVariableDeclaration() && parent.node.declarations.length === 1) {
              parent.remove();
            } else {
              path.remove();
            }
            return;
          }
        }

        // 处理函数表达式和箭头函数的替换
        if (config.replaceFunctionBody) {
          const varName = t.isIdentifier(path.node.id) ? path.node.id.name : null;
          if (!varName) return;

          const init = path.node.init;
          const returnValue = config.replaceFunctionBody[varName];

          if (returnValue && typeof returnValue === 'string' && (t.isFunctionExpression(init) || t.isArrowFunctionExpression(init))) {
            console.log(`替换函数表达式 ${varName} 的函数体，返回: ${returnValue}`);

            if (t.isFunctionExpression(init)) {
              init.body = t.blockStatement([
                t.returnStatement(t.stringLiteral(returnValue))
              ]);
            } else if (t.isArrowFunctionExpression(init)) {
              // 箭头函数，创建块语句体
              init.body = t.blockStatement([
                t.returnStatement(t.stringLiteral(returnValue))
              ]);
            }
          }
        }
      },

      // 处理对象方法
      ObjectMethod(path: any) {
        if (config.replaceFunctionBody) {
          const methodName = t.isIdentifier(path.node.key) ? path.node.key.name : null;
          if (!methodName) return;

          const returnValue = config.replaceFunctionBody[methodName];
          if (returnValue && typeof returnValue === 'string') {
            console.log(`替换对象方法 ${methodName} 的函数体，返回: ${returnValue}`);
            path.node.body = t.blockStatement([
              t.returnStatement(t.stringLiteral(returnValue))
            ]);
          }
        }
      },

      // 处理类方法
      ClassMethod(path: any) {
        if (config.replaceFunctionBody) {
          const methodName = t.isIdentifier(path.node.key) ? path.node.key.name : null;
          if (!methodName) return;

          const returnValue = config.replaceFunctionBody[methodName];
          if (returnValue && typeof returnValue === 'string') {
            console.log(`替换类方法 ${methodName} 的函数体，返回: ${returnValue}`);
            path.node.body = t.blockStatement([
              t.returnStatement(t.stringLiteral(returnValue))
            ]);
          }
        }
      },

      // 移除特定的函数调用
      CallExpression(path: any) {
        if (config.removeFunctionCalls) {
          let calleeName: string | null = null;

          // 处理直接函数调用 foo()
          if (t.isIdentifier(path.node.callee)) {
            calleeName = path.node.callee.name;
          }
          // 处理成员调用 obj.foo()
          else if (t.isMemberExpression(path.node.callee) && t.isIdentifier(path.node.callee.property)) {
            calleeName = path.node.callee.property.name;
          }

          if (calleeName && config.removeFunctionCalls.includes(calleeName)) {
            console.log(`移除函数调用: ${calleeName}`);
            // 如果是表达式语句，移除整个语句
            if (path.parentPath.isExpressionStatement()) {
              path.parentPath.remove();
            } else {
              path.remove();
            }
          }
        }
      }
    });

    // 检查是否有顶层 await 并处理
    let hasTopLevelAwait = false;
    let topLevelAwaitStatements: any[] = [];

    // 收集所有顶层的 await 语句
    ast.program.body = ast.program.body.map((node: any) => {
      if (t.isExpressionStatement(node) && t.isAwaitExpression(node.expression)) {
        hasTopLevelAwait = true;
        topLevelAwaitStatements.push(node);
        return null; // 标记为移除
      }
      return node;
    }).filter((node: any) => node !== null);

    // 如果有顶层 await，在文件末尾添加自执行异步函数
    if (hasTopLevelAwait && topLevelAwaitStatements.length > 0) {
      console.log(`发现 ${topLevelAwaitStatements.length} 个顶层 await 语句，包装为异步函数`);

      // 创建: (async () => { await ...; })();
      const asyncIIFE = t.expressionStatement(
        t.callExpression(
          t.arrowFunctionExpression(
            [],
            t.blockStatement(topLevelAwaitStatements),
            true // async
          ),
          []
        )
      );

      ast.program.body.push(asyncIIFE);
    }

    // 生成修改后的代码
    const output = generate(ast, {
      retainLines: false,
      compact: false,
      comments: true
    });

    return output.code;
  } catch (error) {
    console.error('AST patch 失败:', error);
    throw error;
  }
}

/**
 * 对文件进行 AST patch 并保存
 * @param inputPath 输入文件路径
 * @param outputPath 输出文件路径
 * @param config Patch 配置
 */
export async function patchFileAst(
  inputPath: string,
  outputPath: string,
  config: AstPatchConfig
): Promise<void> {
  try {
    console.log(`开始对文件进行 AST patch: ${inputPath}`);

    // 读取文件
    const code = await readFile(inputPath, 'utf-8');
    console.log(`文件大小: ${code.length} 字符`);

    // 执行 AST patch
    const patchedCode = patchAst(code, config);

    // 写入输出文件
    await writeFile(outputPath, patchedCode, 'utf-8');

    console.log(`AST patch 完成，输出到: ${outputPath}`);
    console.log(`处理后文件大小: ${patchedCode.length} 字符`);
  } catch (error) {
    console.error('文件 AST patch 失败:', error);
    throw error;
  }
}

/**
 * 默认的 droid.js patch 配置
 * 可以根据实际需要修改
 */
export const defaultDroidPatchConfig: AstPatchConfig = {
  // 替换函数体：让 runAutoUpdate 直接返回 "no-update"
  replaceFunctionBody: {
    'runAutoUpdate': 'no-update'
  },
  // 移除调试相关的函数调用
  removeFunctionCalls: [
    // 'console.log',
    // 'console.debug',
  ],
  // 重命名某些标识符
  renameIdentifiers: {
    // 'oldName': 'newName',
  },
  // 移除某些函数或变量
  removeIdentifiers: [
    // 'debugFunction',
  ]
};

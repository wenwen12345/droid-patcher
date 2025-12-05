import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { mkdir, readFile, writeFile, rm, rename, access } from 'fs/promises';
import { join, dirname } from 'path';
import { patchFileAst, defaultDroidPatchConfig } from './ast_patcher.js';

interface DroidDownloadInfo {
  binaryUrl: string;
  sha256Url: string;
  ripgrepUrl: string;
  ripgrepSha256Url: string;
  version: string;
}

interface DroidConfig {
  packageName: string;
  version: string;
  bin_name: string;
}

/**
 * 读取配置文件
 * @param configPath 配置文件路径
 */
async function readConfig(configPath: string): Promise<DroidConfig> {
  try {
    await access(configPath);
    const configContent = await readFile(configPath, 'utf-8');
    return JSON.parse(configContent);
  } catch (error) {
    // 配置文件不存在或读取失败，返回默认配置
    return {
      packageName: 'droid-patched',
      version: '',
      bin_name: 'droid'
    };
  }
}

/**
 * 写入配置文件
 * @param configPath 配置文件路径
 * @param config 配置对象
 */
async function writeConfig(configPath: string, config: DroidConfig): Promise<void> {
  await writeFile(configPath, JSON.stringify(config, null, 2));
  console.log(`配置文件已更新: ${configPath}`);
}

async function fetch_version_from_cli(): Promise<string> {
  const CLI_URL = "https://app.factory.ai/cli";
  
  try {
    const response = await fetch(CLI_URL);
    const scriptContent = await response.text();
    
    // Extract version from the script using regex
    // Look for VER="0.27.4" pattern
    const versionMatch = scriptContent.match(/VER="([^"]+)"/);
    if (versionMatch && versionMatch[1]) {
      return versionMatch[1];
    }
    
    throw new Error("Version not found in CLI script");
  } catch (error) {
    console.error("Failed to fetch version from CLI:", error);
    // Fallback to a known version
    return "0.27.4";
  }
}

async function fetch_droid_download_link(
  platform: string,
  architecture: string,
  hasAvx2: boolean = true
): Promise<DroidDownloadInfo> {
  const VER = await fetch_version_from_cli();
  const BASE_URL = "https://downloads.factory.ai";
  var binary_name = "droid";
  const rg_binary_name = "rg";

  if (platform === "windows") {
    binary_name = "droid.exe"
  }

  // Determine architecture suffix for droid (AVX2 support)
  let arch_suffix = "";
  if (architecture === "x64" && !hasAvx2) {
    arch_suffix = "-baseline";
  }

  const droid_architecture = `${architecture}${arch_suffix}`;
  const rg_architecture = architecture; // ripgrep doesn't have baseline versions

  // Construct URLs
  const binaryUrl = `${BASE_URL}/factory-cli/releases/${VER}/${platform}/${droid_architecture}/${binary_name}`;
  const sha256Url = `${BASE_URL}/factory-cli/releases/${VER}/${platform}/${droid_architecture}/${binary_name}.sha256`;
  const ripgrepUrl = `${BASE_URL}/ripgrep/${platform}/${rg_architecture}/${rg_binary_name}`;
  const ripgrepSha256Url = `${BASE_URL}/ripgrep/${platform}/${rg_architecture}/${rg_binary_name}.sha256`;

  return {
    binaryUrl,
    sha256Url,
    ripgrepUrl,
    ripgrepSha256Url,
    version: VER
  };
}

/**
 * 下载文件到指定路径
 * @param url 文件URL
 * @param filePath 本地文件路径
 */
async function downloadFile(url: string, filePath: string): Promise<void> {
  try {
    const response = await fetch(url);
    if (!response.ok) {
      throw new Error(`Failed to download file: ${response.statusText}`);
    }

    const fileStream = createWriteStream(filePath);
    await pipeline(response.body as any, fileStream);
    
    console.log(`文件已下载到: ${filePath}`);
  } catch (error) {
    console.error(`下载文件失败: ${error}`);
    throw error;
  }
}

/**
 * 移除droid.exe文件的特定头部内容和尾部内容
 * @param filePath 原始文件路径
 * @param outputPath 处理后文件的输出路径
 */
async function removeDroidHeader(filePath: string, outputPath: string): Promise<void> {
  try {
    console.log(`开始处理droid.exe文件: ${filePath}`);

    // 读取文件内容
    let fileBuffer = await readFile(filePath);

    // 头部特征模式：B:/~BUN/root/droid.exe\0// @bun\n
    // 42 3A 2F 7E 42 55 4E 2F 72 6F 6F 74 2F 64 72 6F 69 64 2E 65 78 65 00 2F 2F 20 40 62 75 6E 0A
    const signaturePattern = Buffer.from([
      0x42, 0x3A, 0x2F, 0x7E, 0x42, 0x55, 0x4E, 0x2F,
      0x72, 0x6F, 0x6F, 0x74, 0x2F, 0x64, 0x72, 0x6F,
      0x69, 0x64, 0x2E, 0x65, 0x78, 0x65, 0x00, 0x2F,
      0x2F, 0x20, 0x40, 0x62, 0x75, 0x6E, 0x0A
    ]);

    // 尾部特征模式：//# debugId=
    // 2F 2F 23 20 64 65 62 75 67 49 64 3D
    const tailSignaturePattern = Buffer.from([
      0x2F, 0x2F, 0x23, 0x20, 0x64, 0x65, 0x62, 0x75,
      0x67, 0x49, 0x64, 0x3D
    ]);

    // 第一步：查找头部特征模式
    let signatureIndex = -1;
    for (let i = 0; i <= fileBuffer.length - signaturePattern.length; i++) {
      let match = true;
      for (let j = 0; j < signaturePattern.length; j++) {
        if (fileBuffer[i + j] !== signaturePattern[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        signatureIndex = i;
        break;
      }
    }

    if (signatureIndex === -1) {
      console.log('未找到指定的头部特征模式，直接复制文件');
      await writeFile(outputPath, fileBuffer);
      return;
    }

    console.log(`找到头部特征模式位置: ${signatureIndex}`);

    // 头部需要移除：从文件开头到特征模式结束的位置（不向后截取额外字节）
    const headerEndIndex = signatureIndex + signaturePattern.length;

    // 移除头部及之前的所有内容
    fileBuffer = fileBuffer.slice(headerEndIndex);
    console.log(`已移除头部（从0到${headerEndIndex}），剩余 ${fileBuffer.length} 字节`);

    // 第二步：从文件尾部倒序查找尾部特征模式 //# debugId=（找最后一次出现）
    let tailSignatureIndex = -1;
    for (let i = fileBuffer.length - tailSignaturePattern.length; i >= 0; i--) {
      let match = true;
      for (let j = 0; j < tailSignaturePattern.length; j++) {
        if (fileBuffer[i + j] !== tailSignaturePattern[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        tailSignatureIndex = i;
        break;  // 找到最后一次出现就停止
      }
    }

    if (tailSignatureIndex !== -1) {
      console.log(`找到尾部特征模式 //# debugId= 位置（最后一次出现）: ${tailSignatureIndex}`);

      // 输出匹配位置前2个字节的十六进制（用于调试）
      if (tailSignatureIndex >= 2) {
        const before2Bytes = fileBuffer.slice(tailSignatureIndex - 2, tailSignatureIndex);
        console.log(`特征模式前2个字节: ${Array.from(before2Bytes).map(b => b.toString(16).padStart(2, '0')).join(' ')}`);
      }

      // 尾部需要移除：从特征模式的位置开始截断（不向前截取）
      fileBuffer = fileBuffer.slice(0, tailSignatureIndex);
      console.log(`已移除尾部（从${tailSignatureIndex}开始），剩余 ${fileBuffer.length} 字节`);
    } else {
      console.log('未找到指定的尾部特征模式 //# debugId=，保留所有剩余内容');
    }

    // 写入处理后的文件
    await writeFile(outputPath, fileBuffer);

    console.log(`文件处理完成，输出到: ${outputPath}`);
    console.log(`最终处理后文件大小: ${fileBuffer.length} 字节`);
  } catch (error) {
    console.error(`处理文件失败: ${error}`);
    throw error;
  }
}

/**
 * 下载Windows版本的droid文件并移除特定头部内容
 * @param outputDir 输出目录，默认为当前目录下的'droid'
 * @param configPath 配置文件路径，默认为'./config.json'
 */
async function downloadAndProcessDroid(
  outputDir: string = './droid',
  configPath: string = './config.json'
): Promise<void> {
  try {
    console.log('开始下载 Windows x64版本的droid文件...');

    // 读取当前配置
    const config = await readConfig(configPath);
    console.log(`当前配置版本: ${config.version || '无'}`);

    // 获取Windows x64版本的下载信息
    const downloadInfo = await fetch_droid_download_link('windows', 'x64', true);
    console.log(`远程版本: ${downloadInfo.version}`);

    // 检查版本是否相同
    if (config.version && config.version === downloadInfo.version) {
      console.log('版本相同，无需重新下载和处理');
      return;
    }

    console.log('版本不同或首次运行，开始下载...');
    console.log(downloadInfo);
    
    // 创建输出目录
    await mkdir(outputDir, { recursive: true });
    
    // 下载droid二进制文件
    const binaryPath = join(outputDir, 'droid.exe');
    await downloadFile(downloadInfo.binaryUrl, binaryPath);
    console.log("下载完成");
    
    // 移除文件头部内容
    const processedPath = join(outputDir, 'droid_processed.js');
    await removeDroidHeader(binaryPath, processedPath);

    // 使用 Babel 进行 AST patch
    console.log('\n开始进行 AST patch...');
    const patchedPath = join(outputDir, 'droid_patched.js');
    await patchFileAst(processedPath, patchedPath, defaultDroidPatchConfig);

    // 创建 package 目录（与 outputDir 同级）
    console.log('\n创建 package 目录...');
    const parentDir = dirname(outputDir);
    const packageDir = join(parentDir, 'package');
    await mkdir(packageDir, { recursive: true });

    // 复制处理后的文件到 package 目录，使用 .cjs 扩展名表示 CommonJS
    const packageMainFile = join(packageDir, 'index.cjs');
    await writeFile(packageMainFile, await readFile(patchedPath));

    // 创建 package.json (CommonJS 格式)
    const packageJson = {
      name: config.packageName,
      version: downloadInfo.version,
      main: 'index.cjs',
      bin: {
        [config.bin_name]: 'index.cjs'
      },
      dependencies: {
        'ws': '^8.18.0'
      }
    };
    await writeFile(
      join(packageDir, 'package.json'),
      JSON.stringify(packageJson, null, 2)
    );

    // 删除 tmp 目录
    console.log(`\n删除临时目录: ${outputDir}`);
    await rm(outputDir, { recursive: true, force: true });

    // 更新配置文件版本
    config.version = downloadInfo.version;
    await writeConfig(configPath, config);

    console.log(`\nWindows x64版本的droid文件下载并处理完成`);
    console.log(`包名: ${config.packageName}`);
    console.log(`版本: ${downloadInfo.version}`);
    console.log(`Package 目录: ${packageDir}`);
  } catch (error) {
    console.error(`下载并处理 Windows x64版本droid文件失败: ${error}`);
    throw error;
  }
}

// Export function for use in other modules
export { downloadAndProcessDroid };
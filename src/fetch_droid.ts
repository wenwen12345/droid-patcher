import { createWriteStream, createReadStream } from 'fs';
import { pipeline } from 'stream/promises';
import { mkdir, readFile, writeFile } from 'fs/promises';
import { join } from 'path';

interface DroidDownloadInfo {
  binaryUrl: string;
  sha256Url: string;
  ripgrepUrl: string;
  ripgrepSha256Url: string;
  version: string;
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
    
    // 要移除的头部内容的十六进制表示
    // 8F 67 7F 01 42 3A 2F 7E 42 55 4E 2F 72 6F 6F 74 2F 64 72 6F 69 64 2E 65 78 65 00 2F 2F 20 40 62 75 6E 0A
    const headerToRemove = Buffer.from([
      0x8F, 0x67, 0x7F, 0x01, 0x42, 0x3A, 0x2F, 0x7E,
      0x42, 0x55, 0x4E, 0x2F, 0x72, 0x6F, 0x6F, 0x74,
      0x2F, 0x64, 0x72, 0x6F, 0x69, 0x64, 0x2E, 0x65,
      0x78, 0x65, 0x00, 0x2F, 0x2F, 0x20, 0x40, 0x62,
      0x75, 0x6E, 0x0A
    ]);
    
    // 要移除的尾部内容的十六进制表示
    // 0A 0A 2F 2F 23 20 64 65 62 75 67 49 64 3D 43 42 33 36 30 31 35 33 31 31 38 43 35 32 33 36 36 34 37 35 36 45 32 31 36 34 37 35 36 45 32 31
    const tailToRemove = Buffer.from([
      0x0A, 0x0A, 0x2F, 0x2F, 0x23, 0x20, 0x64, 0x65,
      0x62, 0x75, 0x67, 0x49, 0x64, 0x3D, 0x43, 0x42,
      0x33, 0x36, 0x30, 0x31, 0x35, 0x33, 0x31, 0x31,
      0x38, 0x43, 0x35, 0x32, 0x33, 0x36, 0x36, 0x34,
      0x37, 0x35, 0x36, 0x45, 0x32, 0x31, 0x36, 0x34,
      0x37, 0x35, 0x36, 0x45, 0x32, 0x31
    ]);
    
    // 第一步：移除头部及之前的所有内容
    let headerIndex = -1;
    for (let i = 0; i <= fileBuffer.length - headerToRemove.length; i++) {
      let match = true;
      for (let j = 0; j < headerToRemove.length; j++) {
        if (fileBuffer[i + j] !== headerToRemove[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        headerIndex = i;
        break;
      }
    }
    
    if (headerIndex === -1) {
      console.log('未找到指定的头部内容，直接复制文件');
      await writeFile(outputPath, fileBuffer);
      return;
    }
    
    // 移除头部及之前的所有内容
    fileBuffer = fileBuffer.slice(headerIndex + headerToRemove.length);
    console.log(`已移除头部及之前的内容，剩余 ${fileBuffer.length} 字节`);
    
    // 第二步：查找并移除尾部内容及其之后的所有内容
    let tailIndex = -1;
    for (let i = 0; i <= fileBuffer.length - tailToRemove.length; i++) {
      let match = true;
      for (let j = 0; j < tailToRemove.length; j++) {
        if (fileBuffer[i + j] !== tailToRemove[j]) {
          match = false;
          break;
        }
      }
      if (match) {
        tailIndex = i;
        break;
      }
    }
    
    if (tailIndex !== -1) {
      // 移除尾部内容及其之后的所有内容
      fileBuffer = fileBuffer.slice(0, tailIndex);
      console.log(`已移除尾部及之后的内容，剩余 ${fileBuffer.length} 字节`);
    } else {
      console.log('未找到指定的尾部内容，保留所有剩余内容');
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
 */
async function downloadAndProcessDroid(outputDir: string = './droid'): Promise<void> {
  try {
    console.log('开始下载 Windows x64版本的droid文件...');
    
    // 获取Windows x64版本的下载信息
    const downloadInfo = await fetch_droid_download_link('windows', 'x64', true);
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
    
    console.log(`Windows x64版本的droid文件下载并处理完成，位于: ${outputDir}`);
    console.log(`版本: ${downloadInfo.version}`);
  } catch (error) {
    console.error(`下载并处理 Windows x64版本droid文件失败: ${error}`);
    throw error;
  }
}

// Export function for use in other modules
export { downloadAndProcessDroid };
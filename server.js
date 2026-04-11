const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8080;

// 静态文件托管目录：用于存放生成的预览图，供外部访问
const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
app.use('/outputs', express.static(PUBLIC_DIR));

// CORS 配置
app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');
    res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    if (req.method === 'OPTIONS') {
        return res.sendStatus(200);
    }
    next();
});

app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.send('OK'));

/**
 * 核心转换接口
 * 请求体参数：
 *   image_url: string (必填) - 图片URL
 *   views: array (可选) - 视角数组，可选值 ["front", "perspective", "side"]
 *          默认 ["front", "perspective"]
 */
app.post('/convert', async (req, res) => {
    const { image_url, views = ['front', 'perspective'] } = req.body;
    if (!image_url) {
        return res.status(400).json({ status: 'error', message: '缺少 image_url 参数' });
    }

    // 过滤合法视角
    const validViews = ['front', 'perspective', 'side'];
    const selectedViews = views.filter(v => validViews.includes(v));
    if (selectedViews.length === 0) {
        selectedViews.push('front', 'perspective');
    }

    const taskId = crypto.randomBytes(8).toString('hex');
    const taskDir = path.join(os.tmpdir(), 'png25d', taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    let browser = null;
    let server = null;
    const serverPort = 3000 + Math.floor(Math.random() * 1000);

    try {
        console.log(`[${taskId}] 开始处理，视角：${selectedViews.join(', ')}`);

        // 下载原图
        const imageResponse = await fetch(image_url);
        if (!imageResponse.ok) throw new Error(`下载图片失败: ${imageResponse.status}`);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const pngBase64 = imageBuffer.toString('base64');
        const pngDataUrl = `data:image/png;base64,${pngBase64}`;

        // 复制 resources 目录
        const resourcesSrc = path.join(__dirname, 'resources');
        if (!fs.existsSync(resourcesSrc)) throw new Error('resources 文件夹不存在');
        const resourcesDest = path.join(taskDir, 'resources');
        fs.cpSync(resourcesSrc, resourcesDest, { recursive: true });

        const params = {
            '宽度': '400',
            '深度': '22',
            '保存格式': 'gltf',
            '宽度细分': '400',
            '高度细分': '400',
            '边框': '不勾选'
        };

        // 生成 HTML，传入视角列表
        const html = generateHtml(pngDataUrl, params, taskId, selectedViews);
        const htmlPath = path.join(taskDir, 'index.html');
        fs.writeFileSync(htmlPath, html, 'utf-8');

        // 启动静态服务器，供浏览器访问 HTML 及资源
        server = http.createServer((req, res) => {
            let filePath = path.join(taskDir, req.url === '/' ? 'index.html' : req.url);
            const extname = String(path.extname(filePath)).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
                '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream'
            };
            const contentType = mimeTypes[extname] || 'application/octet-stream';
            fs.readFile(filePath, (error, content) => {
                if (error) {
                    res.writeHead(404);
                    res.end('Not found');
                } else {
                    res.writeHead(200, { 'Content-Type': contentType });
                    res.end(content);
                }
            });
        });
        await new Promise(resolve => server.listen(serverPort, resolve));
        console.log(`[${taskId}] 静态服务器端口: ${serverPort}`);

        // 启动浏览器
        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-web-security', '--no-sandbox', '--disable-gpu',
                '--disable-dev-shm-usage', '--disable-setuid-sandbox',
                '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
                '--disable-accelerated-2d-canvas'
            ]
        });

        const page = await browser.newPage();
        page.on('console', msg => console.log(`[浏览器] ${msg.text()}`));
        page.on('pageerror', err => console.error(`[浏览器页面错误] ${err.message}`));

        await page.goto(`http://localhost:${serverPort}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 等待转换完成，获取截图数组（Base64格式）
        const result = await page.evaluate((targetViews) => {
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (window.conversionResult) {
                        clearInterval(check);
                        resolve(window.conversionResult);
                    }
                }, 500);
                setTimeout(() => {
                    clearInterval(check);
                    resolve({ success: false, error: '转换超时' });
                }, 300000);
            });
        }, selectedViews);

        if (!result || !result.success) throw new Error(result?.error || '转换失败');

        const screenshots = result.screenshots; // 数组，每个元素为 { view, base64 }
        if (!screenshots || screenshots.length === 0) throw new Error('无法获取预览图');

        // 将 Base64 图片保存到 public 目录，并生成公网 URL
        const outputUrls = [];
        const host = req.get('host'); // 获取当前请求的 host
        const protocol = req.protocol; // http 或 https

        for (let i = 0; i < screenshots.length; i++) {
            const item = screenshots[i];
            const base64Data = item.base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            
            // 生成唯一文件名
            const filename = `${taskId}_${item.view}_${Date.now()}.png`;
            const filepath = path.join(PUBLIC_DIR, filename);
            fs.writeFileSync(filepath, buffer);

            // 构造公网 URL（Render 会自动处理 https）
            const publicUrl = `${protocol}://${host}/outputs/${filename}`;
            outputUrls.push({
                view: item.view,
                url: publicUrl
            });
        }

        console.log(`[${taskId}] 转换成功，生成 ${outputUrls.length} 张预览图`);
        res.json({
            status: 'success',
            result_urls: outputUrls,  // 返回数组，每个元素包含视角和公网URL
            message: '多视角生成成功'
        });

    } catch (error) {
        console.error(`[${taskId}] 错误:`, error);
        res.status(500).json({ status: 'error', message: error.message });
    } finally {
        if (browser) await browser.close().catch(() => {});
        if (server) server.close();
        try { fs.rmSync(taskDir, { recursive: true, force: true }); } catch (e) {}
    }
});

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
    console.log(`Public output directory: ${PUBLIC_DIR}`);
});

/**
 * 生成 HTML 页面，支持多视角渲染
 */
function generateHtml(pngDataUrl, params, taskId, views) {
    // 将视角数组转换为 JS 数组字面量
    const viewsArrayStr = JSON.stringify(views);
    
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>PNG to 2.5D Multi-View</title>
    <style>
        body { margin: 0; padding: 20px; font-family: Arial, sans-serif; background: #f0f0f0; }
        #status { background: white; padding: 20px; border-radius: 8px; margin: 20px 0; }
        #progress { width: 100%; height: 20px; background: #e0e0e0; border-radius: 10px; overflow: hidden; margin: 20px 0; }
        #progress-bar { height: 100%; background: #4CAF50; width: 0%; transition: width 0.3s; }
        #preview-container { display: none; }
    </style>
</head>
<body>
    <h2>正在生成2.5D效果图...</h2>
    <div id="status">初始化...</div>
    <div id="progress"><div id="progress-bar"></div></div>
    <div id="preview-container"></div>

    <script src="resources/js/three.min.js"></script>
    <script>
        window.ZACK = { checked: true, checkCredit(){} };
        window.conversionResult = undefined;

        const targetViews = ${viewsArrayStr};

        function updateProgress(percent, message) {
            document.getElementById('progress-bar').style.width = percent + '%';
            document.getElementById('status').textContent = message + ' (' + percent + '%)';
            console.log('进度:', percent + '% -', message);
        }

        async function startConversion() {
            try {
                updateProgress(5, '加载脚本');
                
                function loadScript(src) {
                    return new Promise((resolve, reject) => {
                        const script = document.createElement('script');
                        script.src = src;
                        script.onload = () => { console.log('OK:', src); resolve(); };
                        script.onerror = () => { console.error('FAIL:', src); reject(new Error('脚本加载失败: ' + src)); };
                        document.head.appendChild(script);
                    });
                }

                await loadScript('resources/js/utils.js');
                await loadScript('resources/js/inflate.min.js');
                await loadScript('resources/js/three-pass-extensions.js');
                await loadScript('resources/js/imageObject.patched.js');
                await loadScript('resources/js/exporter.min.js');
                await loadScript('resources/js/jszip.min.js');
                await loadScript('resources/js/GLTFExporter.js');
                
                try {
                    await loadScript('https://cdnjs.cloudflare.com/ajax/libs/earcut/2.2.2/earcut.min.js');
                } catch(e) { console.warn('earcut 回退'); }

                updateProgress(30, '脚本OK');

                const params = ${JSON.stringify(params)};
                const imageUrl = '${pngDataUrl}';

                // 创建渲染器（尺寸稍大以提高截图质量）
                const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: true, alpha: false });
                renderer.setSize(600, 600);
                renderer.setClearColor(0xebebeb, 1);

                updateProgress(40, '加载图片');
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = reject;
                    img.src = imageUrl;
                });

                const w = img.naturalWidth, h = img.naturalHeight, aspect = w / h;
                const targetWidth = Math.min(parseInt(params['宽度']) || 400, 600);
                const targetHeight = Math.round(targetWidth / aspect);
                let widthSegments = parseInt(params['宽度细分']) || 400;
                let heightSegments = Math.max(1, Math.round(widthSegments * (targetHeight / targetWidth)));

                updateProgress(50, '生成3D模型');
                const options = {
                    url: imageUrl,
                    tool: 0,
                    width: targetWidth,
                    widthSegments: widthSegments,
                    height: targetHeight,
                    heightSegments: heightSegments,
                    depth: parseInt(params['深度']) || 22,
                    border: params['边框'] === '勾选'
                };

                console.log('Options:', options);
                const imageObject = new window.ImageObject(renderer, options);
                const object3D = await new Promise((resolve, reject) => {
                    imageObject.onload(async function(obj) {
                        try {
                            const result = await imageObject.getObject(renderer);
                            console.log('模型生成成功');
                            resolve(result);
                        } catch(e) { reject(e); }
                    });
                    setTimeout(() => reject(new Error('模型生成超时')), 120000);
                });

                updateProgress(70, '模型生成完成');

                // 强化哑光效果
                object3D.traverse(child => {
                    if (child.isMesh) {
                        const mat = child.material;
                        if (mat) {
                            if (mat.isMeshStandardMaterial || mat.isMeshPhongMaterial) {
                                mat.roughness = 0.85;
                                mat.metalness = 0.05;
                                mat.emissive = new THREE.Color(0x000000);
                                mat.emissiveIntensity = 0;
                            }
                            mat.needsUpdate = true;
                        }
                    }
                });

                const modelGroup = new THREE.Group();
                modelGroup.add(object3D);

                const box = new THREE.Box3().setFromObject(modelGroup);
                const center = box.getCenter(new THREE.Vector3());
                const size = box.getSize(new THREE.Vector3());

                modelGroup.position.sub(center);
                modelGroup.position.y += size.y / 2;

                modelGroup.rotation.y = 0;
                modelGroup.rotation.x = 0;

                // 设置场景和灯光
                const scene = new THREE.Scene();
                scene.background = new THREE.Color(0xebebeb);
                scene.add(modelGroup);

                const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);
                scene.add(ambientLight);
                
                const frontLight = new THREE.DirectionalLight(0xffffff, 0.35);
                frontLight.position.set(0, 0, 10);
                scene.add(frontLight);
                
                const topLight = new THREE.DirectionalLight(0xffffff, 0.25);
                topLight.position.set(0, 5, 5);
                scene.add(topLight);
                
                const sideLight1 = new THREE.DirectionalLight(0xffeedd, 0.15);
                sideLight1.position.set(5, 2, 5);
                scene.add(sideLight1);
                
                const sideLight2 = new THREE.DirectionalLight(0xddddff, 0.15);
                sideLight2.position.set(-5, 2, 5);
                scene.add(sideLight2);

                const backLight = new THREE.DirectionalLight(0xffffff, 0.1);
                backLight.position.set(0, 2, -8);
                scene.add(backLight);

                // 定义相机位置映射
                const cameraPositions = {
                    front: { pos: [0, size.y * 0.5, size.z * 2.5], lookAt: [0, size.y * 0.5, 0] },
                    perspective: { pos: [size.x * 1.8, size.y * 0.8, size.z * 2.2], lookAt: [0, size.y * 0.4, 0] },
                    side: { pos: [size.x * 2.5, size.y * 0.5, 0], lookAt: [0, size.y * 0.5, 0] }
                };

                const screenshots = [];

                // 为每个视角渲染并截图
                for (let i = 0; i < targetViews.length; i++) {
                    const viewName = targetViews[i];
                    const camConfig = cameraPositions[viewName] || cameraPositions.front;
                    
                    updateProgress(75 + (i * 10), '渲染视角: ' + viewName);

                    // 创建新相机
                    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
                    camera.position.set(camConfig.pos[0], camConfig.pos[1], camConfig.pos[2]);
                    camera.lookAt(camConfig.lookAt[0], camConfig.lookAt[1], camConfig.lookAt[2]);

                    // 渲染两次确保稳定
                    renderer.render(scene, camera);
                    renderer.render(scene, camera);

                    const canvas = renderer.domElement;
                    const screenshot = canvas.toDataURL('image/png');
                    
                    screenshots.push({
                        view: viewName,
                        base64: screenshot
                    });
                }

                updateProgress(100, '完成');
                window.conversionResult = { 
                    success: true, 
                    screenshots: screenshots 
                };
            } catch(error) {
                console.error('转换错误:', error);
                updateProgress(0, '失败: ' + error.message);
                window.conversionResult = { success: false, error: error.message };
            }
        }

        window.onload = startConversion;
    </script>
</body>
</html>`;
}
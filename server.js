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
app.get('/', (req, res) => res.send('PNG to 2.5D Multi-View API is running.'));

/**
 * 核心转换接口
 */
app.post('/convert', async (req, res) => {
    const { image_url, views = ['front', 'perspective'] } = req.body;
    if (!image_url) {
        return res.status(400).json({ status: 'error', message: '缺少 image_url 参数' });
    }

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

        // 生成 HTML，传入 Base64 图片数据
        const html = generateHtml(pngBase64, params, taskId, selectedViews);
        const htmlPath = path.join(taskDir, 'index.html');
        fs.writeFileSync(htmlPath, html, 'utf-8');

        // 启动静态服务器
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
        
        // 收集浏览器控制台错误
        const browserErrors = [];
        page.on('console', msg => {
            const text = msg.text();
            console.log(`[浏览器] ${text}`);
            if (msg.type() === 'error') browserErrors.push(text);
        });
        page.on('pageerror', err => {
            console.error(`[浏览器页面错误] ${err.message}`);
            browserErrors.push(err.message);
        });

        await page.goto(`http://localhost:${serverPort}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        // 等待转换结果
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
                    resolve({ success: false, error: '转换超时 (5分钟)' });
                }, 300000);
            });
        }, selectedViews);

        // 如果有浏览器错误，附加到结果中
        if (browserErrors.length > 0) {
            result.browserErrors = browserErrors;
        }

        if (!result || !result.success) {
            const errorDetail = result?.error || '未知转换错误';
            const browserInfo = browserErrors.length ? ` 浏览器错误: ${browserErrors.join('; ')}` : '';
            throw new Error(errorDetail + browserInfo);
        }

        const screenshots = result.screenshots;
        if (!screenshots || screenshots.length === 0) throw new Error('无法获取预览图');

        // 保存图片并生成公网 URL
        const outputUrls = [];
        const host = req.get('host');
        const protocol = req.protocol;

        for (let i = 0; i < screenshots.length; i++) {
            const item = screenshots[i];
            const base64Data = item.base64.replace(/^data:image\/\w+;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            
            const filename = `${taskId}_${item.view}_${Date.now()}.png`;
            const filepath = path.join(PUBLIC_DIR, filename);
            fs.writeFileSync(filepath, buffer);

            const publicUrl = `${protocol}://${host}/outputs/${filename}`;
            outputUrls.push({
                view: item.view,
                url: publicUrl
            });
        }

        console.log(`[${taskId}] 转换成功，生成 ${outputUrls.length} 张预览图`);
        res.json({
            status: 'success',
            result_urls: outputUrls,
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
 * 生成 HTML 页面（增强错误捕获，使用 Blob URL 加载图片）
 */
function generateHtml(pngBase64, params, taskId, views) {
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
    </style>
</head>
<body>
    <h2>正在生成2.5D效果图...</h2>
    <div id="status">初始化...</div>
    <div id="progress"><div id="progress-bar"></div></div>

    <script src="resources/js/three.min.js"></script>
    <script>
        window.ZACK = { checked: true, checkCredit(){} };
        window.conversionResult = undefined;

        const targetViews = ${viewsArrayStr};
        const pngBase64 = '${pngBase64}';

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

                // 将 Base64 转换为 Blob URL，确保兼容性
                const byteCharacters = atob(pngBase64);
                const byteNumbers = new Array(byteCharacters.length);
                for (let i = 0; i < byteCharacters.length; i++) {
                    byteNumbers[i] = byteCharacters.charCodeAt(i);
                }
                const byteArray = new Uint8Array(byteNumbers);
                const blob = new Blob([byteArray], { type: 'image/png' });
                const imageUrl = URL.createObjectURL(blob);

                // 创建渲染器
                const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: true, alpha: false });
                renderer.setSize(600, 600);
                renderer.setClearColor(0xebebeb, 1);

                updateProgress(40, '加载图片');
                const img = new Image();
                await new Promise((resolve, reject) => {
                    img.onload = resolve;
                    img.onerror = () => reject(new Error('图片加载失败'));
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
                
                let object3D;
                try {
                    const imageObject = new window.ImageObject(renderer, options);
                    object3D = await new Promise((resolve, reject) => {
                        imageObject.onload(async function(obj) {
                            try {
                                const result = await imageObject.getObject(renderer);
                                console.log('模型生成成功');
                                resolve(result);
                            } catch(e) { reject(e); }
                        });
                        setTimeout(() => reject(new Error('模型生成超时')), 120000);
                    });
                } catch (modelError) {
                    throw new Error('ImageObject 处理失败: ' + modelError.message);
                }

                updateProgress(70, '模型生成完成');

                // 材质强化与纹理检查
                object3D.traverse(child => {
                    if (child.isMesh) {
                        const mat = child.material;
                        if (mat) {
                            const applySettings = (material) => {
                                if (material.isMeshStandardMaterial || material.isMeshPhongMaterial) {
                                    material.roughness = 0.6;
                                    material.metalness = 0.0;
                                    material.emissive = new THREE.Color(0x000000);
                                    material.emissiveIntensity = 0;
                                    // 如果纹理丢失，给一个基础颜色防止完全透明
                                    if (!material.map) {
                                        console.warn('材质缺少纹理，使用基础色');
                                        material.color.setHex(0xcccccc);
                                    }
                                    material.needsUpdate = true;
                                }
                            };
                            if (Array.isArray(mat)) {
                                mat.forEach(m => applySettings(m));
                            } else {
                                applySettings(mat);
                            }
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

                // 场景与灯光
                const scene = new THREE.Scene();
                scene.background = new THREE.Color(0xebebeb);
                scene.add(modelGroup);

                const ambientLight = new THREE.AmbientLight(0xffffff, 0.5);
                scene.add(ambientLight);
                
                const frontLight = new THREE.DirectionalLight(0xffffff, 0.4);
                frontLight.position.set(0, 0, 10);
                scene.add(frontLight);
                
                const topLight = new THREE.DirectionalLight(0xffffff, 0.3);
                topLight.position.set(0, 5, 5);
                scene.add(topLight);
                
                const sideLight1 = new THREE.DirectionalLight(0xffeedd, 0.2);
                sideLight1.position.set(5, 2, 5);
                scene.add(sideLight1);
                
                const sideLight2 = new THREE.DirectionalLight(0xddddff, 0.2);
                sideLight2.position.set(-5, 2, 5);
                scene.add(sideLight2);

                const backLight = new THREE.DirectionalLight(0xffffff, 0.15);
                backLight.position.set(0, 2, -8);
                scene.add(backLight);

                const fillLight = new THREE.DirectionalLight(0xffeedd, 0.3);
                fillLight.position.set(0, size.y * 0.5, size.z * 3);
                scene.add(fillLight);

                // 相机位置
                const cameraPositions = {
                    front: {
                        pos: [0, size.y * 0.5, Math.max(size.x, size.y, size.z) * 2.8],
                        lookAt: [0, size.y * 0.5, 0]
                    },
                    perspective: {
                        pos: [size.x * 1.5, size.y * 0.6, size.z * 2.0],
                        lookAt: [0, size.y * 0.4, 0]
                    },
                    side: {
                        pos: [size.x * 2.5, size.y * 0.5, 0],
                        lookAt: [0, size.y * 0.5, 0]
                    }
                };

                const screenshots = [];

                for (let i = 0; i < targetViews.length; i++) {
                    const viewName = targetViews[i];
                    const camConfig = cameraPositions[viewName] || cameraPositions.front;
                    
                    updateProgress(75 + (i * 10), '渲染视角: ' + viewName);

                    const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
                    camera.position.set(camConfig.pos[0], camConfig.pos[1], camConfig.pos[2]);
                    camera.lookAt(camConfig.lookAt[0], camConfig.lookAt[1], camConfig.lookAt[2]);

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
                
                // 清理 Blob URL
                URL.revokeObjectURL(imageUrl);
                
            } catch(error) {
                console.error('转换错误:', error);
                updateProgress(0, '失败: ' + error.message);
                window.conversionResult = { 
                    success: false, 
                    error: error.message,
                    stack: error.stack
                };
            }
        }

        window.onload = startConversion;
    </script>
</body>
</html>`;
}
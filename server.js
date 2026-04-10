const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 8080;

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

app.post('/convert', async (req, res) => {
    const { image_url } = req.body;
    if (!image_url) {
        return res.status(400).json({ status: 'error', message: '缺少 image_url 参数' });
    }

    const taskId = crypto.randomBytes(8).toString('hex');
    const taskDir = path.join(__dirname, 'tasks', taskId);
    fs.mkdirSync(taskDir, { recursive: true });

    let browser = null;
    let server = null;
    const serverPort = 3000 + Math.floor(Math.random() * 1000);

    try {
        console.log(`[${taskId}] 开始处理`);

        const imageResponse = await fetch(image_url);
        if (!imageResponse.ok) throw new Error(`下载图片失败: ${imageResponse.status}`);
        const imageBuffer = Buffer.from(await imageResponse.arrayBuffer());
        const pngBase64 = imageBuffer.toString('base64');
        const pngDataUrl = `data:image/png;base64,${pngBase64}`;

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

        const html = generateHtml(pngDataUrl, params, taskId);
        const htmlPath = path.join(taskDir, 'index.html');
        fs.writeFileSync(htmlPath, html, 'utf-8');

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

        const result = await page.evaluate(() => {
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
        });

        if (!result || !result.success) throw new Error(result?.error || '转换失败');

        const screenshotBase64 = result.screenshot;
        if (!screenshotBase64) throw new Error('无法获取预览图');

        console.log(`[${taskId}] 转换成功`);
        res.json({ status: 'success', result_url: screenshotBase64 });

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
});

function generateHtml(pngDataUrl, params, taskId) {
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>PNG to 2.5D Preview</title>
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

                const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: true, alpha: false });
                renderer.setSize(400, 400);
                renderer.setClearColor(0xebebeb, 1); // 略微压暗背景

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

                updateProgress(80, '渲染预览图');

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

                const scene = new THREE.Scene();
                scene.background = new THREE.Color(0xebebeb);
                scene.add(modelGroup);

                // 最终柔和光照（强度再降）
                const ambientLight = new THREE.AmbientLight(0xffffff, 0.4);   // 0.5 → 0.4
                scene.add(ambientLight);
                
                const frontLight = new THREE.DirectionalLight(0xffffff, 0.35); // 0.45 → 0.35
                frontLight.position.set(0, 0, 10);
                scene.add(frontLight);
                
                const topLight = new THREE.DirectionalLight(0xffffff, 0.25);   // 0.35 → 0.25
                topLight.position.set(0, 5, 5);
                scene.add(topLight);
                
                const sideLight1 = new THREE.DirectionalLight(0xffeedd, 0.15); // 0.2 → 0.15
                sideLight1.position.set(5, 2, 5);
                scene.add(sideLight1);
                
                const sideLight2 = new THREE.DirectionalLight(0xddddff, 0.15); // 0.2 → 0.15
                sideLight2.position.set(-5, 2, 5);
                scene.add(sideLight2);

                const backLight = new THREE.DirectionalLight(0xffffff, 0.1);   // 0.15 → 0.1
                backLight.position.set(0, 2, -8);
                scene.add(backLight);

                const camera = new THREE.PerspectiveCamera(45, 1, 0.1, 1000);
                const maxDim = Math.max(size.x, size.y, size.z);
                const distance = maxDim * 1.8;
                camera.position.set(0, size.y * 0.5, distance);
                camera.lookAt(0, size.y * 0.5, 0);

                renderer.render(scene, camera);
                renderer.render(scene, camera);

                const canvas = renderer.domElement;
                console.log('Canvas尺寸:', canvas.width, 'x', canvas.height);

                const screenshot = canvas.toDataURL('image/png');

                updateProgress(100, '完成');
                window.conversionResult = { success: true, screenshot: screenshot };
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
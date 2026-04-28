const express = require('express');
const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');
const crypto = require('crypto');
const os = require('os');

const app = express();
const PORT = process.env.PORT || 8080;

const PUBLIC_DIR = path.join(__dirname, 'public');
if (!fs.existsSync(PUBLIC_DIR)) {
    fs.mkdirSync(PUBLIC_DIR, { recursive: true });
}
app.use('/outputs', express.static(PUBLIC_DIR));
app.use('/resources', express.static(path.join(__dirname, 'resources')));

app.use((req, res, next) => {
    res.header('Access-Control-Allow-Origin', '*');
    res.header('Access-Control-Allow-Headers', 'Content-Type');
    res.header('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

app.use(express.json({ limit: '50mb' }));

app.get('/health', (req, res) => res.send('OK'));
app.get('/', (req, res) => res.send('PNG to 2.5D Printable Keychain API is running.'));

app.post('/convert', async (req, res) => {
    const { image_url, views = ['front', 'perspective'], format = 'stl', width_mm = 30, depth_mm = 4 } = req.body;
    if (!image_url) return res.status(400).json({ status: 'error', message: '缺少 image_url 参数' });

    const validViews = ['front', 'perspective', 'side'];
    const selectedViews = views.filter(v => validViews.includes(v));
    if (selectedViews.length === 0) selectedViews.push('front', 'perspective');

    const taskId = crypto.randomBytes(8).toString('hex');
    const taskDir = path.join(os.tmpdir(), 'png25d', taskId);
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
            '深度': depth_mm.toString(),
            '保存格式': 'gltf',
            '宽度细分': '400',
            '高度细分': '400',
            '边框': '不勾选'
        };

        const html = generateHtml(pngDataUrl, params, selectedViews, format, width_mm, depth_mm);
        const htmlPath = path.join(taskDir, 'index.html');
        fs.writeFileSync(htmlPath, html, 'utf-8');

        server = http.createServer((req, res) => {
            let filePath = path.join(taskDir, req.url === '/' ? 'index.html' : req.url);
            const extname = String(path.extname(filePath)).toLowerCase();
            const mimeTypes = {
                '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css',
                '.png': 'image/png', '.jpg': 'image/jpeg', '.wasm': 'application/wasm',
                '.gltf': 'model/gltf+json', '.bin': 'application/octet-stream', '.stl': 'application/sla'
            };
            const contentType = mimeTypes[extname] || 'application/octet-stream';
            fs.readFile(filePath, (error, content) => {
                if (error) { res.writeHead(404); res.end('Not found'); }
                else { res.writeHead(200, { 'Content-Type': contentType }); res.end(content); }
            });
        });
        await new Promise(resolve => server.listen(serverPort, resolve));

        browser = await chromium.launch({
            headless: true,
            args: [
                '--disable-web-security', '--no-sandbox', '--disable-gpu',
                '--disable-dev-shm-usage', '--enable-unsafe-swiftshader', '--use-gl=swiftshader',
                '--disable-accelerated-2d-canvas'
            ]
        });

        const page = await browser.newPage();
        page.on('console', msg => console.log(`[浏览器] ${msg.text()}`));
        page.on('pageerror', err => console.error(`[浏览器错误] ${err.message}`));

        await page.goto(`http://localhost:${serverPort}/`, { waitUntil: 'domcontentloaded', timeout: 60000 });

        const result = await page.evaluate(() => {
            return new Promise((resolve) => {
                const check = setInterval(() => {
                    if (window.conversionResult) { clearInterval(check); resolve(window.conversionResult); }
                }, 500);
                setTimeout(() => { clearInterval(check); resolve({ success: false, error: '转换超时' }); }, 300000);
            });
        });

        if (!result || !result.success) throw new Error(result?.error || '转换失败');

        const screenshots = result.screenshots;
        const modelData = result.model;
        if (!modelData || !modelData.base64) throw new Error('模型数据缺失');

        const host = req.get('host');
        const protocol = req.protocol;
        const outputUrls = [];

        for (let i = 0; i < screenshots.length; i++) {
            const item = screenshots[i];
            const base64Data = item.base64.replace(/^data:image\/png;base64,/, '');
            const buffer = Buffer.from(base64Data, 'base64');
            const filename = taskId + '_' + item.view + '_' + Date.now() + '.png';
            fs.writeFileSync(path.join(PUBLIC_DIR, filename), buffer);
            outputUrls.push({ view: item.view, url: protocol + '://' + host + '/outputs/' + filename });
        }

        const modelExt = format === 'stl' ? '.stl' : '.glb';
        const modelFilename = taskId + '_keychain' + modelExt;
        const modelFilePath = path.join(PUBLIC_DIR, modelFilename);
        fs.writeFileSync(modelFilePath, Buffer.from(modelData.base64, 'base64'));
        const modelUrl = protocol + '://' + host + '/outputs/' + modelFilename;

        res.json({
            status: 'success',
            preview_urls: outputUrls,
            model_url: modelUrl,
            model_format: format,
            message: '3D 打印钥匙扣模型已生成（未打悬挂孔）'
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
});

// 生成 HTML（同样修复了 Base64 问题）
function generateHtml(pngDataUrl, params, views, exportFormat, width_mm, depth_mm) {
    const viewsArrayStr = JSON.stringify(views);
    return `<!DOCTYPE html>
<html>
<head>
    <meta charset="utf-8">
    <title>2.5D Keychain Generator</title>
    <style>
        body { margin: 0; padding: 20px; font-family: Arial; background: #f0f0f0; }
        #status { background: white; padding: 20px; border-radius: 8px; }
        #progress { width: 100%; height: 20px; background: #e0e0e0; border-radius: 10px; overflow: hidden; }
        #progress-bar { height: 100%; background: #4CAF50; width: 0%; }
    </style>
</head>
<body>
    <h2>正在生成3D打印钥匙扣...</h2>
    <div id="status">初始化...</div>
    <div id="progress"><div id="progress-bar"></div></div>

    <script src="resources/js/three.min.js"></script>
    <script>
        window.ZACK = { checked: true, checkCredit(){} };
        window.conversionResult = undefined;

        function updateProgress(percent, message) {
            document.getElementById('progress-bar').style.width = percent + '%';
            document.getElementById('status').textContent = message + ' (' + percent + '%)';
            console.log('进度:', percent + '% - ' + message);
        }

        function loadScript(src) {
            return new Promise((resolve, reject) => {
                const script = document.createElement('script');
                script.src = src;
                script.onload = () => { console.log('OK:', src); resolve(); };
                script.onerror = () => reject(new Error('脚本加载失败: ' + src));
                document.head.appendChild(script);
            });
        }

        // 安全的 Base64 转换（修复栈溢出）
        function uint8ArrayToBase64(bytes) {
            let binary = '';
            const chunkSize = 0x8000;
            for (let i = 0; i < bytes.byteLength; i += chunkSize) {
                binary += String.fromCharCode.apply(null, bytes.subarray(i, i + chunkSize));
            }
            return btoa(binary);
        }

        function makeWatertightSolid(geometry, depth) {
            const positions = geometry.attributes.position.array;
            const uvs = geometry.attributes.uv ? geometry.attributes.uv.array : null;
            const indices = geometry.index ? geometry.index.array.slice() : null;

            if (!indices) {
                const tris = [];
                for (let i = 0; i < positions.length / 3; i += 3) tris.push([i, i + 1, i + 2]);
                geometry.setIndex(tris.flat());
                return makeWatertightSolid(geometry, depth);
            }

            const vertexCount = positions.length / 3;
            const newPositions = new Float32Array(vertexCount * 6);
            const newUvs = uvs ? new Float32Array(vertexCount * 4) : null;
            const newIndices = [];

            for (let i = 0; i < vertexCount; i++) {
                newPositions[i * 3]     = positions[i * 3];
                newPositions[i * 3 + 1] = positions[i * 3 + 1];
                newPositions[i * 3 + 2] = positions[i * 3 + 2];
                if (newUvs && uvs) {
                    newUvs[i * 2]     = uvs[i * 2];
                    newUvs[i * 2 + 1] = uvs[i * 2 + 1];
                }
                const idx = vertexCount + i;
                newPositions[idx * 3]     = positions[i * 3];
                newPositions[idx * 3 + 1] = positions[i * 3 + 1];
                newPositions[idx * 3 + 2] = positions[i * 3 + 2] - depth;
                if (newUvs && uvs) {
                    newUvs[idx * 2]     = uvs[i * 2];
                    newUvs[idx * 2 + 1] = uvs[i * 2 + 1];
                }
            }

            for (let i = 0; i < indices.length; i += 3) {
                newIndices.push(indices[i], indices[i + 1], indices[i + 2]);
            }
            for (let i = 0; i < indices.length; i += 3) {
                newIndices.push(indices[i + 2] + vertexCount, indices[i + 1] + vertexCount, indices[i] + vertexCount);
            }

            const edgeMap = new Map();
            for (let i = 0; i < indices.length; i += 3) {
                const a = indices[i], b = indices[i + 1], c = indices[i + 2];
                [[a, b], [b, c], [c, a]].forEach(([v1, v2]) => {
                    const key = v1 < v2 ? v1 + '_' + v2 : v2 + '_' + v1;
                    if (edgeMap.has(key)) edgeMap.delete(key);
                    else edgeMap.set(key, [v1, v2]);
                });
            }
            edgeMap.forEach(([v1, v2]) => {
                const v1Bot = v1 + vertexCount, v2Bot = v2 + vertexCount;
                newIndices.push(v1, v2, v2Bot);
                newIndices.push(v1, v2Bot, v1Bot);
            });

            const solidGeo = new THREE.BufferGeometry();
            solidGeo.setAttribute('position', new THREE.BufferAttribute(newPositions, 3));
            if (newUvs) solidGeo.setAttribute('uv', new THREE.BufferAttribute(newUvs, 2));
            solidGeo.setIndex(newIndices);
            solidGeo.computeVertexNormals();
            return solidGeo;
        }

        function exportSTLBinary(object) {
            const geometries = [];
            object.traverse(child => {
                if (child.isMesh) {
                    const geo = child.geometry.clone();
                    geo.applyMatrix4(child.matrixWorld);
                    geometries.push(geo);
                }
            });
            let positions = [], indices = [], vertexOffset = 0;
            for (const geo of geometries) {
                if (!geo.index) continue;
                const pos = geo.attributes.position;
                for (let i = 0; i < pos.count; i++) positions.push(pos.getX(i), pos.getY(i), pos.getZ(i));
                for (const idx of geo.index.array) indices.push(idx + vertexOffset);
                vertexOffset += pos.count;
            }
            const triangleCount = indices.length / 3;
            const buffer = new ArrayBuffer(84 + 50 * triangleCount);
            new Uint8Array(buffer, 0, 80).fill(32);
            const view = new DataView(buffer);
            view.setUint32(80, triangleCount, true);
            let offset = 84;
            for (let i = 0; i < indices.length; i += 3) {
                const a = indices[i], b = indices[i + 1], c = indices[i + 2];
                const ax = positions[a*3], ay = positions[a*3+1], az = positions[a*3+2];
                const bx = positions[b*3], by = positions[b*3+1], bz = positions[b*3+2];
                const cx = positions[c*3], cy = positions[c*3+1], cz = positions[c*3+2];
                const ux = bx-ax, uy = by-ay, uz = bz-az;
                const vx = cx-ax, vy = cy-ay, vz = cz-az;
                const nx = uy*vz - uz*vy, ny = uz*vx - ux*vz, nz = ux*vy - uy*vx;
                const len = Math.sqrt(nx*nx+ny*ny+nz*nz) || 1;
                view.setFloat32(offset, nx/len, true); offset+=4;
                view.setFloat32(offset, ny/len, true); offset+=4;
                view.setFloat32(offset, nz/len, true); offset+=4;
                view.setFloat32(offset, ax, true); offset+=4;
                view.setFloat32(offset, ay, true); offset+=4;
                view.setFloat32(offset, az, true); offset+=4;
                view.setFloat32(offset, bx, true); offset+=4;
                view.setFloat32(offset, by, true); offset+=4;
                view.setFloat32(offset, bz, true); offset+=4;
                view.setFloat32(offset, cx, true); offset+=4;
                view.setFloat32(offset, cy, true); offset+=4;
                view.setFloat32(offset, cz, true); offset+=4;
                view.setUint16(offset, 0, true); offset+=2;
            }
            return new Uint8Array(buffer);
        }

        async function startConversion() {
            try {
                updateProgress(5, '加载脚本');
                await loadScript('resources/js/utils.js');
                await loadScript('resources/js/inflate.min.js');
                await loadScript('resources/js/three-pass-extensions.js');
                await loadScript('resources/js/imageObject.patched.js');
                await loadScript('resources/js/exporter.min.js');
                await loadScript('resources/js/jszip.min.js');
                await loadScript('resources/js/GLTFExporter.js');
                try { await loadScript('https://cdnjs.cloudflare.com/ajax/libs/earcut/2.2.2/earcut.min.js'); } catch(e) { console.warn('earcut 失败'); }

                updateProgress(25, '脚本完成');
                const params = ${JSON.stringify(params)};
                const imageUrl = '${pngDataUrl}';
                const renderer = new THREE.WebGLRenderer({ preserveDrawingBuffer: true, antialias: true, alpha: false });
                renderer.setSize(400, 400);
                renderer.setClearColor(0xffffff, 1);

                const img = new Image();
                await new Promise((resolve, reject) => { img.onload = resolve; img.onerror = reject; img.src = imageUrl; });
                const w = img.naturalWidth, h = img.naturalHeight;
                const targetWidth = Math.min(parseInt(params['宽度']) || 400, 600);
                const targetHeight = Math.round(targetWidth / (w/h));
                const widthSegments = parseInt(params['宽度细分']) || 400;
                const heightSegments = Math.max(1, Math.round(widthSegments * (targetHeight / targetWidth)));

                updateProgress(40, '生成曲面');
                const options = {
                    url: imageUrl, tool: 0, width: targetWidth, widthSegments,
                    height: targetHeight, heightSegments,
                    depth: parseFloat(params['深度']) || ${depth_mm},
                    border: params['边框'] === '勾选'
                };
                const imageObject = new window.ImageObject(renderer, options);
                const object3D = await new Promise((resolve, reject) => {
                    imageObject.onload(async (obj) => {
                        try { resolve(await imageObject.getObject(renderer)); } catch(e) { reject(e); }
                    });
                    setTimeout(() => reject(new Error('超时')), 120000);
                });

                updateProgress(60, '实体化');
                object3D.traverse(child => {
                    if (child.isMesh && child.geometry) {
                        child.geometry = makeWatertightSolid(child.geometry, parseFloat(params['深度']) || ${depth_mm});
                        if (child.material) { child.material.side = THREE.DoubleSide; child.material.needsUpdate = true; }
                    }
                });

                const box = new THREE.Box3().setFromObject(object3D);
                const maxDim = Math.max(...box.getSize(new THREE.Vector3()).toArray());
                const scale = ${width_mm} / maxDim;
                object3D.scale.set(scale, scale, scale);

                console.log('悬挂孔功能已跳过');

                updateProgress(80, '渲染');
                const scene = new THREE.Scene();
                scene.background = new THREE.Color(0xebebeb);
                const modelGroup = new THREE.Group();
                modelGroup.add(object3D);
                const cb = new THREE.Box3().setFromObject(modelGroup);
                const center = cb.getCenter(new THREE.Vector3());
                modelGroup.position.sub(center);
                modelGroup.position.y -= cb.min.y - center.y;
                scene.add(modelGroup);

                scene.add(new THREE.AmbientLight(0xffffff, 0.4));
                const dl = (c,i,x,y,z) => { const l = new THREE.DirectionalLight(c,i); l.position.set(x,y,z); scene.add(l); };
                dl(0xffffff,0.35,0,0,10); dl(0xffffff,0.25,0,5,5);
                dl(0xffeedd,0.15,5,2,5); dl(0xddddff,0.15,-5,2,5); dl(0xffffff,0.1,0,2,-8);

                const sizeObj = new THREE.Box3().setFromObject(modelGroup).getSize(new THREE.Vector3());
                const cameraPositions = {
                    front: { pos: [0, sizeObj.y*0.5, Math.max(sizeObj.x,sizeObj.y,sizeObj.z)*1.8], lookAt: [0, sizeObj.y*0.5, 0] },
                    perspective: { pos: [sizeObj.x*2.2, sizeObj.y*0.9, sizeObj.z*2.8], lookAt: [sizeObj.x*0.3, sizeObj.y*0.5, sizeObj.z*0.4] },
                    side: { pos: [sizeObj.x*2.5, sizeObj.y*0.5, 0], lookAt: [0, sizeObj.y*0.5, 0] }
                };
                const screenshots = [];
                for (const view of ${viewsArrayStr}) {
                    const config = cameraPositions[view] || cameraPositions.front;
                    const camera = new THREE.PerspectiveCamera(45,1,0.1,1000);
                    camera.position.set(config.pos[0], config.pos[1], config.pos[2]);
                    camera.lookAt(config.lookAt[0], config.lookAt[1], config.lookAt[2]);
                    renderer.render(scene, camera);
                    renderer.render(scene, camera);
                    screenshots.push({ view, base64: renderer.domElement.toDataURL('image/png') });
                }

                updateProgress(95, '导出');
                let modelBase64;
                if ('${exportFormat}' === 'stl') {
                    const stlBytes = exportSTLBinary(modelGroup);
                    modelBase64 = uint8ArrayToBase64(stlBytes);  // ← 修复处
                } else {
                    const exporter = new THREE.GLTFExporter();
                    const glb = await new Promise(resolve => exporter.parse(modelGroup, resolve, { binary: true }));
                    modelBase64 = btoa(Array.from(new Uint8Array(glb)).map(b => String.fromCharCode(b)).join(''));
                }

                updateProgress(100, '完成');
                window.conversionResult = {
                    success: true,
                    screenshots,
                    model: { format: '${exportFormat}', base64: modelBase64 }
                };
            } catch(e) {
                console.error(e);
                updateProgress(0, '失败: ' + e.message);
                window.conversionResult = { success: false, error: e.message };
            }
        }

        window.onload = startConversion;
    </script>
</body>
</html>`;
}
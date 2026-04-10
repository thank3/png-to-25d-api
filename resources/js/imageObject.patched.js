(function(){

// Minimal, readable ImageObject replacement with depth postprocessing (median filter)
// Depends on THREE.js being loaded in the page.

function defaultOptions(){
    return {
        url: '../../img/exampleImage.png',
        width: 400,
        widthSegments: 400,
        height: 400,
        heightSegments: 400,
        depth: 10,
        depthFilter: { enabled: true, kernel: 3 },
        // 形态学闭运算参数：先膨胀再腐蚀以填补小孔
        depthClosing: { enabled: true, kernel: 3 },
        // 孔洞填充参数：启用后对小孔进行基于邻域的平均填充
        holeFill: { enabled: true, maxRadius: 6 }
    };
}

function medianFilterFloat32(buf, w, h, k){
    k = k || 3; if(k < 3 || k % 2 === 0) k = 3; const half = Math.floor(k/2);
    const out = new Float32Array(buf.length);
    const window = new Float32Array(k*k);
    for(let yy = 0; yy < h; yy++){
        for(let xx = 0; xx < w; xx++){
            let wi = 0;
            for(let dy = -half; dy <= half; dy++){
                const yrow = Math.min(h-1, Math.max(0, yy+dy));
                for(let dx = -half; dx <= half; dx++){
                    const xcol = Math.min(w-1, Math.max(0, xx+dx));
                    window[wi++] = buf[yrow*w + xcol];
                }
            }
            // simple insertion sort for small window
            for(let i1 = 1; i1 < window.length; i1++){
                const v = window[i1];
                let j = i1 - 1;
                while(j >= 0 && window[j] > v){ window[j+1] = window[j]; j--; }
                window[j+1] = v;
            }
            out[yy*w + xx] = window[Math.floor(window.length/2)];
        }
    }
    for(let i = 0; i < buf.length; i++) buf[i] = out[i];
}

function grayscaleDilate(buf, w, h, k){
    const half = Math.floor(k/2);
    const out = new Float32Array(buf.length);
    for(let y=0;y<h;y++){
        for(let x=0;x<w;x++){
            let maxv = -Infinity;
            for(let dy=-half; dy<=half; dy++){
                const yy = Math.min(h-1, Math.max(0, y+dy));
                for(let dx=-half; dx<=half; dx++){
                    const xx = Math.min(w-1, Math.max(0, x+dx));
                    const v = buf[yy*w + xx];
                    if(v > maxv) maxv = v;
                }
            }
            out[y*w + x] = maxv;
        }
    }
    for(let i=0;i<buf.length;i++) buf[i]=out[i];
}

function grayscaleErode(buf, w, h, k){
    const half = Math.floor(k/2);
    const out = new Float32Array(buf.length);
    for(let y=0;y<h;y++){
        for(let x=0;x<w;x++){
            let minv = Infinity;
            for(let dy=-half; dy<=half; dy++){
                const yy = Math.min(h-1, Math.max(0, y+dy));
                for(let dx=-half; dx<=half; dx++){
                    const xx = Math.min(w-1, Math.max(0, x+dx));
                    const v = buf[yy*w + xx];
                    if(v < minv) minv = v;
                }
            }
            out[y*w + x] = minv;
        }
    }
    for(let i=0;i<buf.length;i++) buf[i]=out[i];
}

// Fill small holes (pixels with value <= eps) by averaging valid neighbors within expanding radius up to maxRadius
function fillHolesByNeighborhood(buf, w, h, maxRadius, eps){
    eps = eps || 1e-6;
    const out = new Float32Array(buf);
    const isValid = i => buf[i] > eps;
    for(let y=0;y<h;y++){
        for(let x=0;x<w;x++){
            const idx = y*w + x;
            if(isValid(idx)) continue;
            let filled = false;
            for(let r=1; r<=maxRadius && !filled; r++){
                let sum = 0, cnt = 0;
                const y0 = Math.max(0, y-r), y1 = Math.min(h-1, y+r);
                const x0 = Math.max(0, x-r), x1 = Math.min(w-1, x+r);
                for(let yy=y0; yy<=y1; yy++){
                    for(let xx=x0; xx<=x1; xx++){
                        const j = yy*w + xx;
                        if(isValid(j)) { sum += buf[j]; cnt++; }
                    }
                }
                if(cnt > 0){ out[idx] = sum / cnt; filled = true; }
            }
        }
    }
    for(let i=0;i<buf.length;i++) buf[i]=out[i];
}

window.ImageObject = class ImageObject extends THREE.Group {
    constructor(renderer, options){
        super();
        this.renderer = renderer;
        this.options = Object.assign(defaultOptions(), options || {});
        this._loadedTexture = null;
        this._onload = null;

        // 开始异步加载纹理，加载完成后触发 onload 回调（如果已注册）
        this._loadTexture(this.options.url).then(tex => {
            this._loadedTexture = tex;
            this._loadedTexture.flipY = false;
            if (typeof this._onload === 'function') {
                try { this._onload(this); } catch(e) { console.warn('onload callback error', e); }
            }
        }).catch(err => {
            console.warn('ImageObject texture load failed', err);
            if (typeof this._onload === 'function') {
                try { this._onload(this); } catch(e) { console.warn('onload callback error', e); }
            }
        });
    }

    onload(cb){
        this._onload = cb;
        if (this._loadedTexture && typeof this._onload === 'function') {
            try { this._onload(this); } catch(e) { console.warn('onload callback error', e); }
        }
    }

    // load texture (returns promise)
    _loadTexture(url){
        return new Promise((resolve, reject) => {
            const loader = new THREE.TextureLoader();
            loader.load(url, tex => resolve(tex), undefined, err => reject(err));
        });
    }

    // The main function used by the conversion flow: returns a THREE.Object3D
    async getObject(renderer){
        const opt = this.options;
        // ensure texture loaded
        if(!this._loadedTexture){
            this._loadedTexture = await this._loadTexture(opt.url);
            this._loadedTexture.flipY = false;
        }

        const w = opt.widthSegments;
        const h = opt.heightSegments;
        // render shader that converts the source texture to grayscale in red channel
        const scene = new THREE.Scene();
        const cam = new THREE.OrthographicCamera(-1,1,1,-1,0,1);

        const mat = new THREE.ShaderMaterial({
            uniforms: {
                diffuse: { value: this._loadedTexture }
            },
            vertexShader: 'varying vec2 vUv; void main(){ vUv = uv; gl_Position = vec4(position,1.0); }',
            fragmentShader: '\n                varying vec2 vUv;\n                uniform sampler2D diffuse;\n                float parseGray(vec4 c){ return c.r*0.9 + c.g*0.08 + c.b*0.02; }\n                void main(){ float g = parseGray(texture2D(diffuse, vUv)); gl_FragColor = vec4(g,0.0,0.0,1.0); }\n            '
        });
        const quad = new THREE.Mesh(new THREE.PlaneBufferGeometry(2,2), mat);
        scene.add(quad);

        const target = new THREE.WebGLRenderTarget(w, h, { type: THREE.FloatType, format: THREE.RedFormat, magFilter: THREE.NearestFilter, minFilter: THREE.NearestFilter });
        const oldTarget = renderer.getRenderTarget();
        const oldPixelRatio = renderer.getPixelRatio();
        try{
            renderer.setPixelRatio(1);
            renderer.setRenderTarget(target);
            renderer.clear();
            renderer.render(scene, cam);

            const depthArray = new Float32Array(w*h);
            // readRenderTargetPixels supports FloatType with Float32Array
            renderer.readRenderTargetPixels(target, 0, 0, w, h, depthArray);

            // optional median filter
            if(opt.depthFilter && opt.depthFilter.enabled){
                medianFilterFloat32(depthArray, w, h, opt.depthFilter.kernel || 3);
            }

            // morphology closing: dilate then erode to close small holes
            if(opt.depthClosing && opt.depthClosing.enabled){
                const k = opt.depthClosing.kernel || 3;
                grayscaleDilate(depthArray, w, h, k);
                grayscaleErode(depthArray, w, h, k);
            }

            // hole filling: fill remaining small holes by neighborhood averaging
            if(opt.holeFill && opt.holeFill.enabled){
                const maxR = Math.max(1, Math.floor(opt.holeFill.maxRadius || 6));
                fillHolesByNeighborhood(depthArray, w, h, maxR, 1e-5);
            }

            // build geometry: Plane with (w x h) vertices -> segments w-1, h-1
            const geom = new THREE.PlaneBufferGeometry(opt.width, opt.height, w-1, h-1);
            const posAttr = geom.attributes.position;
            const pos = posAttr.array;
            const vertCount = posAttr.count;
            // pos layout: x,y,z per vertex. plane is centered. We map depthArray into z
            for(let vi = 0; vi < vertCount; vi++){
                // depthArray index: row-major from bottom-left (readRenderTargetPixels gives bottom-left first)
                // PlaneBufferGeometry orders vertices row-major top-to-bottom; flip Y to match
                const row = Math.floor(vi / (w));
                const col = vi % w;
                const depthVal = depthArray[(h-1-row)*w + col];
                pos[vi*3 + 2] = depthVal * opt.depth;
            }
            posAttr.needsUpdate = true;
            if(typeof geom.computeVertexNormals === 'function') geom.computeVertexNormals();

            const material = new THREE.MeshStandardMaterial({ map: this._loadedTexture, side: THREE.DoubleSide, transparent: true });
            const mesh = new THREE.Mesh(geom, material);
            const group = new THREE.Group();
            group.add(mesh);
            return group;

        } finally {
            renderer.setPixelRatio(oldPixelRatio);
            renderer.setRenderTarget(oldTarget);
            try{ target.dispose(); }catch(e){}
            try{ mat.dispose(); }catch(e){}
            try{ quad.geometry.dispose(); }catch(e){}
        }
    }
};

})();

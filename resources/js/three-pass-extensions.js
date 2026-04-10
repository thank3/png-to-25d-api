// THREE.js Pass extensions for r128
// FullScreenQuad and Blur Shaders

(function() {
    'use strict';

    if (typeof THREE === 'undefined') {
        console.error('THREE.js must be loaded before this script');
        return;
    }

    // FullScreenQuad - A full-screen quad for post-processing
    THREE.Pass = THREE.Pass || {};
    
    THREE.Pass.FullScreenQuad = function(material) {
        this.material = material;
        
        const geometry = new THREE.PlaneGeometry(2, 2);
        this.mesh = new THREE.Mesh(geometry, material);
    };

    THREE.Pass.FullScreenQuad.prototype = {
        constructor: THREE.Pass.FullScreenQuad,
        
        render: function(renderer) {
            if (this.material.uniforms) {
                this.material.uniforms.tDiffuse = this.material.uniforms.tDiffuse || { value: null };
            }
            
            renderer.render(this.mesh, new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1));
        },
        
        dispose: function() {
            this.mesh.geometry.dispose();
        }
    };

    // Horizontal Blur Shader
    THREE.HorizontalBlurShader = {
        uniforms: {
            tDiffuse: { value: null },
            h: { value: 1.0 / 512.0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D tDiffuse;
            uniform float h;
            varying vec2 vUv;
            void main() {
                vec4 sum = vec4(0.0);
                sum += texture2D(tDiffuse, vec2(vUv.x - 4.0 * h, vUv.y)) * 0.051;
                sum += texture2D(tDiffuse, vec2(vUv.x - 3.0 * h, vUv.y)) * 0.0918;
                sum += texture2D(tDiffuse, vec2(vUv.x - 2.0 * h, vUv.y)) * 0.12245;
                sum += texture2D(tDiffuse, vec2(vUv.x - 1.0 * h, vUv.y)) * 0.1531;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y)) * 0.1633;
                sum += texture2D(tDiffuse, vec2(vUv.x + 1.0 * h, vUv.y)) * 0.1531;
                sum += texture2D(tDiffuse, vec2(vUv.x + 2.0 * h, vUv.y)) * 0.12245;
                sum += texture2D(tDiffuse, vec2(vUv.x + 3.0 * h, vUv.y)) * 0.0918;
                sum += texture2D(tDiffuse, vec2(vUv.x + 4.0 * h, vUv.y)) * 0.051;
                gl_FragColor = sum;
            }
        `
    };

    // Vertical Blur Shader
    THREE.VerticalBlurShader = {
        uniforms: {
            tDiffuse: { value: null },
            v: { value: 1.0 / 512.0 }
        },
        vertexShader: `
            varying vec2 vUv;
            void main() {
                vUv = uv;
                gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
            }
        `,
        fragmentShader: `
            uniform sampler2D tDiffuse;
            uniform float v;
            varying vec2 vUv;
            void main() {
                vec4 sum = vec4(0.0);
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 4.0 * v)) * 0.051;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 3.0 * v)) * 0.0918;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 2.0 * v)) * 0.12245;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y - 1.0 * v)) * 0.1531;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y)) * 0.1633;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 1.0 * v)) * 0.1531;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 2.0 * v)) * 0.12245;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 3.0 * v)) * 0.0918;
                sum += texture2D(tDiffuse, vec2(vUv.x, vUv.y + 4.0 * v)) * 0.051;
                gl_FragColor = sum;
            }
        `
    };

    console.log('THREE.js Pass extensions loaded');
})();


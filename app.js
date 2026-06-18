const video = document.getElementById('webcam');
const canvas = document.getElementById('overlay');
const ctx = canvas.getContext('2d');
const alertBanner = document.getElementById('alertBanner');
const snapBtn = document.getElementById('snapBtn');

let session = null;
let lastAlertTime = 0;
const MODEL_WIDTH = 640;  // YOLOv9 標準輸入寬度
const MODEL_HEIGHT = 640; // YOLOv9 標準輸入長度

// 1. 初始化網頁：載入 AI 模型並啟動相機
async function init() {
    try {
        console.log("正在載入 YOLOv9 ONNX 模型...");
        // 優先使用 WebGL 硬件加速，如果手機不支援則自動降級到 WASM (CPU)
        session = await ort.InferenceSession.create('./best.onnx', { executionProviders: ['webgl', 'wasm'] });
        console.log("模型載入成功！");

        setupCamera();
    } catch (e) {
        console.error("模型載入失敗:", e);
        alert("無法初始化 AI 模型。請確保 'best.onnx' 檔案已放在與 index.html 相同的資料夾中。");
    }
}

// 2. 啟動 iPhone 後置鏡頭
function setupCamera() {
    // facingMode: "environment" 會強制瀏覽器調用手機的後置主鏡頭
    navigator.mediaDevices.getUserMedia({
        video: { facingMode: "environment", width: 640, height: 480 },
        audio: false
    })
    .then((stream) => {
        video.srcObject = stream;
        video.addEventListener('loadedmetadata', () => {
            canvas.width = video.videoWidth;
            canvas.height = video.videoHeight;
            // 開始無窮迴圈捕捉畫面進行辨識
            requestAnimationFrame(processFrame);
        });
    })
    .catch((err) => {
        console.error("無法取得相機權限: ", err);
        alert("請允許相機權限以進行馬匹辨識。");
    });
}

// 3. 每幀畫面的即時辨識迴圈
async function processFrame() {
    if (video.paused || video.ended) return;

    // 前處理：把相機影像縮放並轉換成 YOLO 要求的 1x3x640x640 Float32 張量 (Tensor)
    const tensorInput = preprocess(video, MODEL_WIDTH, MODEL_HEIGHT);

    // 執行推理 (Inference)
    const feeds = {};
    feeds[session.inputNames[0]] = tensorInput;
    const outputMap = await session.run(feeds);
    
    // 取得模型的輸出數據
    const outputTensor = outputMap[session.outputNames[0]];
    
    // 後處理：解析輸出數據並過濾出「馬」
    const detections = postprocess(outputTensor.data, outputTensor.dims);
    
    // 將結果繪製到螢幕上
    renderDetections(detections);

    // 繼續下一幀畫面
    requestAnimationFrame(processFrame);
}

// 4. 前處理影像數據
function preprocess(videoElement, width, height) {
    const tempCanvas = document.createElement('canvas');
    tempCanvas.width = width;
    tempCanvas.height = height;
    const tempCtx = tempCanvas.getContext('2d');
    tempCtx.drawImage(videoElement, 0, 0, width, height);
    
    const imgData = tempCtx.getImageData(0, 0, width, height);
    const float32Buffer = new Float32Array(3 * width * height);

    // 將 RGBA 轉為 YOLO 格式 (NCHW 格式：所有 R 先排列，接著所有 G，最後所有 B)，並將像素 0-255 正規化至 0-1
    for (let i = 0; i < imgData.data.length / 4; i++) {
        float32Buffer[i] = imgData.data[i * 4] / 255.0;        // R
        float32Buffer[width * height + i] = imgData.data[i * 4 + 1] / 255.0; // G
        float32Buffer[2 * width * height + i] = imgData.data[i * 4 + 2] / 255.0; // B
    }

    return new ort.Tensor('float32', float32Buffer, [1, 3, width, height]);
}

// 5. 後處理：解析 YOLOv9 矩陣數據 (Confidence 門檻設為 50%)
function postprocess(data, dims) {
    const detections = [];
    const confidenceThreshold = 0.50; 
    
    const numBoxes = dims[2]; 
    // 假設你的 custom 訓練模型只有 1 個類別（馬），那麼輸出屬性通常為：[cx, cy, w, h, 馬的信心度]
    // 這裡採用標準的單類別解析邏輯
    for (let i = 0; i < numBoxes; i++) {
        let score = data[4 * numBoxes + i]; // 取得信心度分數
        
        if (score > confidenceThreshold) {
            let cx = data[i];
            let cy = data[numBoxes + i];
            let w = data[2 * numBoxes + i];
            let h = data[3 * numBoxes + i];

            // 將中心點坐標轉為左上角坐標
            let x = cx - w / 2;
            let y = cy - h / 2;

            detections.push({
                box: [x, y, w, h],
                score: score
            });
        }
    }
    return detections;
}

// 6. 畫出綠色辨識框與警報
function renderDetections(detections) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    let horseFound = false;

    detections.forEach(det => {
        horseFound = true;
        const [x, y, w, h] = det.box;

        // 把模型坐標 (640x640) 映射回實際網頁畫布大小
        const scaleX = canvas.width / MODEL_WIDTH;
        const scaleY = canvas.height / MODEL_HEIGHT;

        // 畫框
        ctx.strokeStyle = '#00FF00';
        ctx.lineWidth = 4;
        ctx.strokeRect(x * scaleX, y * scaleY, w * scaleX, h * scaleY);

        // 畫標籤背景
        ctx.fillStyle = '#00FF00';
        ctx.font = 'bold 16px Arial';
        const label = `Horse: ${Math.round(det.score * 100)}%`;
        const textWidth = ctx.measureText(label).width;
        ctx.fillRect(x * scaleX, (y * scaleY) - 25, textWidth + 10, 25);

        // 寫字
        ctx.fillStyle = '#000000';
        ctx.fillText(label, (x * scaleX) + 5, (y * scaleY) - 7);
    });

    // 觸發紅色警報橫幅與手機特效
    if (horseFound) {
        alertBanner.style.display = 'block';
        triggerAlertEffects();
    } else {
        alertBanner.style.display = 'none';
    }
}

// 7. 警報特效（震動與音效，每 2 秒限制觸發一次防干擾）
function triggerAlertEffects() {
    const now = Date.now();
    if (now - lastAlertTime > 2000) {
        lastAlertTime = now;
        
        // 呼叫手機震動 (部分 iOS 瀏覽器有安全限制，需使用者互動過後才生效)
        if (navigator.vibrate) {
            navigator.vibrate([200, 100, 200]);
        }
        
        // 使用 Web Audio API 播放電子嗶嗶聲
        const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
        const oscillator = audioCtx.createOscillator();
        oscillator.type = 'sine';
        oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // 880Hz 高音
        oscillator.connect(audioCtx.destination);
        oscillator.start();
        oscillator.stop(audioCtx.currentTime + 0.15); // 響 0.15 秒
    }
}

// 8. 截圖功能：結合相機畫面與綠色框框儲存
snapBtn.addEventListener('click', () => {
    const snapCanvas = document.createElement('canvas');
    snapCanvas.width = canvas.width;
    snapCanvas.height = canvas.height;
    const snapCtx = snapCanvas.getContext('2d');

    // 先疊加相機畫面，再疊加 AI 綠框畫布
    snapCtx.drawImage(video, 0, 0, snapCanvas.width, snapCanvas.height);
    snapCtx.drawImage(canvas, 0, 0, snapCanvas.width, snapCanvas.height);

    // 觸發瀏覽器下載行為
    const link = document.createElement('a');
    link.download = `horse-snapshot-${Date.now()}.png`;
    link.href = snapCanvas.toDataURL('image/png');
    link.click();
});

// 啟動專案
window.onload = init;

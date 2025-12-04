import { useState, useEffect, useRef, useCallback, type ChangeEvent, type FC, type JSX } from 'react';

// --- Types and Interfaces ---
type AnalysisState = 'idle' | 'loading' | 'complete' | 'failed' | 'api-key-missing';

interface AnalysisResult {
    classification: string;
    description: string;
}

// --- Constants ---
const API_RETRIES: number = 3;
const INITIAL_DELAY_MS: number = 1000;
const API_MODEL: string = import.meta.env.VITE_GEMINI_MODEL;

// --- Utility Functions ---
/**
 * Converts a base64 Data URL to its raw base64 string and MIME type.
 */
const parseDataUrl = (dataUrl: string): { base64: string; mimeType: string } | null => {
    const parts = dataUrl.split(';base64,');
    if (parts.length !== 2) return null;
    const mimeType = parts[0].substring(5).split(';')[0];
    const base64 = parts[1];
    return { base64, mimeType };
};

/**
 * Parses and formats the description from the Gemini response, handling newlines.
 */
const formatDescription = (description: string): JSX.Element => {
    if (!description) return <p className="text-gray-500">No description available.</p>;

    return (
        <div className="text-base text-gray-700">
            {description.split('\n')
                .filter(p => p.trim() !== '')
                .map((p, index) => <p key={index} className="mb-2">{p}</p>)
            }
        </div>
    );
};


// --- Main React Component ---
const App: FC = () => {


    const apiKey: string = import.meta.env.VITE_GEMINI_KEY; 
    const API_URL: string = `${import.meta.env.VITE_BASE_URL}/${API_MODEL}:generateContent?key=${apiKey}`;

    // --- State Management ---
    const [isStreaming, setIsStreaming] = useState<boolean>(false);
    const [capturedImage, setCapturedImage] = useState<string | null>(null); // Base64 URL
    const [analysisState, setAnalysisState] = useState<AnalysisState>('idle'); 
    const [analysisResult, setAnalysisResult] = useState<AnalysisResult | null>(null);
    const [error, setError] = useState<string | null>(null);

    // --- Refs for DOM elements ---
    const videoRef = useRef<HTMLVideoElement | null>(null);
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const streamRef = useRef<MediaStream | null>(null);
    const fileInputRef = useRef<HTMLInputElement | null>(null);


    // --- Core Functionality: API Analysis ---

    const analyzeImage = useCallback(async (imageDataUrl: string): Promise<void> => {
        if (!imageDataUrl) return;

        if (!apiKey) {
            setAnalysisState('api-key-missing');
            setError("Gemini API key is missing. Please update the 'apiKey' variable.");
            return;
        }

        setError(null);
        setAnalysisState('loading');
        setAnalysisResult(null);

        const parsedImage = parseDataUrl(imageDataUrl);
        if (!parsedImage) {
            setAnalysisState('failed');
            setError('Error parsing image data for Gemini API.');
            return;
        }

        const systemPrompt: string = "You are a world-class object recognition and descriptive AI. Based on the input image, identify the primary subject and provide a detailed, engaging summary of it. Respond only with a JSON object.";
        const userPrompt: string = "Analyze this image. Identify the object and provide a detailed description. Focus on high accuracy for the primary classification.";
        
        const payload: object = {
            contents: [{
                role: "user",
                parts: [
                    { text: userPrompt },
                    {
                        inlineData: {
                            mimeType: parsedImage.mimeType,
                            data: parsedImage.base64
                        }
                    }
                ]
            }],
            systemInstruction: {
                parts: [{ text: systemPrompt }]
            },
            generationConfig: {
                responseMimeType: "application/json",
                responseSchema: {
                    type: "OBJECT",
                    properties: {
                        classification: { type: "STRING" },
                        description: { type: "STRING" }
                    },
                    required: ["classification", "description"]
                }
            }
        };

        for (let i = 0; i < API_RETRIES; i++) {
            try {
                const response = await fetch(API_URL, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(payload)
                });

                if (!response.ok) {
                    throw new Error(`HTTP error! status: ${response.status}`);
                }

                const result = await response.json();
                const jsonText: string | undefined = result?.candidates?.[0]?.content?.parts?.[0]?.text;
                
                if (!jsonText) throw new Error("API returned an empty or malformed response.");

                const analysis: AnalysisResult = JSON.parse(jsonText);
                setAnalysisResult(analysis);
                setAnalysisState('complete');
                return; // Success
                
            } catch (err) {
                console.error(`Gemini API call failed (Attempt ${i + 1}):`, err);
                if (i === API_RETRIES - 1) {
                    setAnalysisState('failed');
                    setError(`Analysis failed after ${API_RETRIES} attempts. Error: ${(err as Error).message}`);
                } else {
                    const delay: number = INITIAL_DELAY_MS * Math.pow(2, i);
                    await new Promise(resolve => setTimeout(resolve, delay));
                }
            }
        }
    }, [apiKey, API_URL]);


    // --- Camera Control Functions ---

    const stopCamera = useCallback((): void => {
        if (streamRef.current) {
            streamRef.current.getTracks().forEach(track => track.stop());
        }
        streamRef.current = null;
        if (videoRef.current) {
            videoRef.current.srcObject = null;
        }
        setIsStreaming(false);
    }, []);

    const startCamera = async (): Promise<void> => {
        if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
            setError("Media devices API not supported by this browser.");
            return;
        }

        stopCamera();
        setError(null);
        setAnalysisState('idle');

        for (let i = 0; i < API_RETRIES; i++) {
            try {
                const stream: MediaStream = await navigator.mediaDevices.getUserMedia({ video: true });
                streamRef.current = stream;
                
                if (videoRef.current) {
                    videoRef.current.srcObject = stream;
                    videoRef.current.play();
                }
                setIsStreaming(true);
                return; // Success

            } catch (err) {
                console.error("Error accessing media devices:", err);
                if (i === API_RETRIES - 1) {
                    setError(`Cannot start camera after ${API_RETRIES} attempts. Error: ${(err as Error).name}. Check permissions.`);
                    setIsStreaming(false);
                    return;
                }
                const delay: number = INITIAL_DELAY_MS * Math.pow(2, i);
                await new Promise(resolve => setTimeout(resolve, delay));
            }
        }
    };

    const snapImage = (): void => {
        const video = videoRef.current;
        const canvas = canvasRef.current;

        if (!video || !canvas || !isStreaming) {
            setError('Camera is not active. Please start the camera first.');
            return;
        }
        
        // Ensure video is loaded and playing
        if (video.videoWidth === 0 || video.videoHeight === 0) {
            setError("Video stream not ready. Try again in a moment.");
            return;
        }

        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        
        const ctx = canvas.getContext('2d');
        if (!ctx) {
            setError('Could not get 2D rendering context from canvas.');
            return;
        }

        ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

        const imageDataUrl: string = canvas.toDataURL('image/png');
        setCapturedImage(imageDataUrl);
        stopCamera();
        
        // --- AUTOMATIC ANALYSIS TRIGGER ---
        analyzeImage(imageDataUrl);
    };

    // --- File Handling ---
    const handleFileChange = (event: ChangeEvent<HTMLInputElement>): void => {
        const file: File | undefined = event.target.files?.[0];
        if (!file) return;

        if (!file.type.startsWith('image/')) {
            setError('Please select a valid image file.');
            return;
        }

        const reader: FileReader = new FileReader();
        reader.onload = (e: ProgressEvent<FileReader>) => {
            const imageDataUrl: string = e.target?.result as string;
            setCapturedImage(imageDataUrl);
            setError(null);
            if (fileInputRef.current) fileInputRef.current.value = '';
            
            // --- AUTOMATIC ANALYSIS TRIGGER ---
            analyzeImage(imageDataUrl);
        };
        reader.onerror = () => setError('Error reading the selected file.');
        reader.readAsDataURL(file);
    };

    // --- Cleanup Effect ---
    useEffect(() => {
        return () => {
            // Cleanup on component unmount
            stopCamera();
        };
    }, [stopCamera]);

    // --- UI Helper: Status Bar Content ---
    const getAnalysisStatusUI = (): JSX.Element => {
        let text: string = 'Ready for Analysis';
        let color: string = 'bg-blue-600';
        let loadingIcon: boolean = false;

        if (analysisState === 'loading') {
            text = 'Analyzing...';
            color = 'bg-indigo-600';
            loadingIcon = true;
        } else if (analysisState === 'complete') {
            text = 'Analysis Complete';
            color = 'bg-green-600';
        } else if (analysisState === 'failed') {
            text = 'Analysis Failed';
            color = 'bg-red-600';
        } else if (analysisState === 'api-key-missing') {
            text = 'API Key Missing!';
            color = 'bg-red-800';
        } else if (isStreaming) {
            text = 'Camera Active - Snap to Analyze';
            color = 'bg-yellow-600';
        }

        return (
            <div className={`w-full py-3 px-4 text-center text-lg font-semibold rounded-lg text-white ${color} shadow-lg transition-colors duration-200 flex items-center justify-center`}>
                {loadingIcon && (
                    <div className="animate-spin h-5 w-5 mr-3 border-2 border-white border-t-transparent rounded-full inline-block"></div>
                )}
                {text}
            </div>
        );
    };

    // --- Render ---
    return (
        <div className="flex flex-col items-center min-h-screen p-4 md:p-8 bg-gray-100">
            <div className="w-full max-w-7xl mx-auto flex flex-col md:flex-row space-y-6 md:space-y-0 md:space-x-6">

                {/* 1. Controls / Input Panel */}
                <div id="control-panel" className="md:w-1/3 w-full bg-white p-6 rounded-2xl shadow-2xl h-fit sticky top-8">
                    <h1 className="text-2xl font-extrabold text-gray-800 mb-6 border-b pb-2">
                        <span className="text-indigo-600">Gemini</span> Vision Analyst
                    </h1>
                    
                    <div className="space-y-4">
                        
                        {/* Camera Controls */}
                        <div className="flex space-x-3">
                            <button 
                                onClick={startCamera} 
                                disabled={isStreaming}
                                className="flex-1 py-3 px-4 text-lg font-semibold rounded-xl text-white bg-indigo-600 hover:bg-indigo-700 transition duration-150 ease-in-out shadow-md disabled:bg-gray-400 focus:outline-none focus:ring-4 focus:ring-indigo-500 focus:ring-opacity-50"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 inline mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M3 9a2 2 0 012-2h.93a2 2 0 001.664-.89l.812-1.22A2 2 0 0110.778 3h2.444a2 2 0 011.664.89l.812 1.22A2 2 0 0018.07 7H19a2 2 0 012 2v9a2 2 0 01-2 2H5a2 2 0 01-2-2V9z" />
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M15 13a3 3 0 11-6 0 3 3 0 016 0z" />
                                </svg>
                                {isStreaming ? 'Streaming...' : 'Start Camera'}
                            </button>
                            <button 
                                onClick={snapImage}
                                disabled={!isStreaming}
                                className="w-1/3 py-3 px-4 text-lg font-semibold rounded-xl text-white bg-green-600 hover:bg-green-700 transition duration-150 ease-in-out shadow-md disabled:bg-gray-400"
                            >
                                Snap
                            </button>
                        </div>
                        
                        {/* File Upload Controls */}
                        <div className="flex space-x-3">
                            <button 
                                onClick={() => { stopCamera(); fileInputRef.current?.click(); }}
                                className="flex-1 py-3 px-4 text-lg font-semibold rounded-xl text-gray-800 bg-gray-200 hover:bg-gray-300 transition duration-150 ease-in-out shadow-md focus:outline-none focus:ring-4 focus:ring-gray-500 focus:ring-opacity-50"
                            >
                                <svg xmlns="http://www.w3.org/2000/svg" className="h-6 w-6 inline mr-2" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" d="M4 16v1a3 3 0 003 3h10a3 3 0 003-3v-1m-4-8l-4-4m0 0L8 8m4-4v12" />
                                </svg>
                                Upload Image
                            </button>
                            {/* Hidden file input */}
                            <input 
                                type="file" 
                                ref={fileInputRef}
                                onChange={handleFileChange}
                                accept="image/*" 
                                className="hidden"
                            />
                        </div>
                        
                        {/* Analysis Status */}
                        {getAnalysisStatusUI()}

                        {/* Stop Camera Button */}
                        {isStreaming && (
                            <button 
                                onClick={stopCamera} 
                                className="w-full py-2 px-4 text-sm font-medium rounded-xl text-gray-500 bg-transparent hover:bg-gray-100 transition duration-150 ease-in-out border border-gray-300 mt-2"
                            >
                                Stop Camera Stream
                            </button>
                        )}
                        
                        {/* Error/Status Box */}
                        {(error || analysisState === 'api-key-missing') && (
                            <div className="p-4 bg-red-100 border border-red-400 text-red-700 rounded-lg text-sm font-medium" role="alert">
                                {error || "API Key is missing or invalid. Please check the code for the 'apiKey' variable."}
                            </div>
                        )}

                        {/* API Key Reminder */}
                        {apiKey.length === 0 && (
                            <div className="p-3 bg-yellow-100 border-l-4 border-yellow-500 text-yellow-800 rounded-lg text-sm">
                                <p className="font-bold">Action Required:</p>
                                <p>Please insert your Gemini API key in the `apiKey` variable to enable analysis.</p>
                            </div>
                        )}
                    </div>
                </div>

                {/* 2. Image Display and Results / Output Panel */}
                <div id="output-panel" className="md:w-2/3 w-full space-y-6">
                    
                    {/* Image Area */}
                    <div className="bg-white p-4 rounded-2xl shadow-xl">
                        <h2 className="text-xl font-semibold text-gray-800 mb-4">Current Image Preview</h2>
                        <div className="relative rounded-xl overflow-hidden shadow-inner flex items-center justify-center bg-gray-900" style={{ minHeight: '20rem' }}>
                            
                            {/* Live Video Feed */}
                            <video 
                                ref={videoRef}
                                autoPlay 
                                playsInline 
                                className={`w-full h-full object-cover ${isStreaming ? '' : 'hidden'}`}
                            ></video>
                            
                            {/* Hidden Canvas for capturing snapshots */}
                            <canvas ref={canvasRef} className="hidden"></canvas>

                            {/* Image Output Area */}
                            {capturedImage && !isStreaming && (
                                <img 
                                    src={capturedImage} 
                                    alt="Captured or Uploaded" 
                                    className="w-full h-full object-contain p-4"
                                />
                            )}

                            {/* Overlay Message */}
                            {(!capturedImage && !isStreaming) && (
                                <div className="absolute inset-0 flex items-center justify-center p-4 text-center text-gray-400 font-medium">
                                    Start camera or upload an image to begin.
                                </div>
                            )}
                        </div>
                    </div>

                    {/* Analysis Results */}
                    <div id="results-feed" className="bg-white p-6 rounded-2xl shadow-xl space-y-6">
                        <h2 className="text-xl font-semibold text-gray-800 border-b pb-2">AI Analysis Feed</h2>
                        
                        {(analysisState === 'idle' && !capturedImage) && (
                            <div className="p-4 rounded-xl text-gray-500 bg-gray-100">
                                Snap an image or upload one to start the automatic analysis.
                            </div>
                        )}

                        {/* Analysis Response Card (Where Gemini results are injected) */}
                        {(analysisResult || analysisState === 'loading' || analysisState === 'failed') && (
                            <div className="ai-response-card p-4 rounded-xl shadow-md border-l-4 border-indigo-500 bg-white">
                                
                                {/* Classification Output */}
                                <div className="mb-4">
                                    <p className="font-bold text-lg text-indigo-600 mb-2">Classification:</p>
                                    {analysisState === 'loading' && (
                                        <div className="flex items-center text-indigo-600 font-semibold text-xl">
                                            <div className="animate-spin h-6 w-6 mr-3 border-4 border-indigo-500 border-t-transparent rounded-full"></div>
                                            Identifying primary subject...
                                        </div>
                                    )}
                                    {analysisState !== 'loading' && (
                                        <p className="font-semibold text-gray-800 text-2xl">
                                            {analysisResult?.classification || 'N/A'}
                                        </p>
                                    )}
                                </div>
                                
                                {/* Description Output */}
                                <div className="border-t pt-4">
                                    <p className="font-bold text-lg text-indigo-600 mb-2">Detailed Description:</p>
                                    {analysisState === 'loading' && (
                                        <p className="text-gray-500 italic">Generating detailed summary...</p>
                                    )}
                                    {analysisState === 'failed' && (
                                        <p className="text-red-500">Failed to retrieve description.</p>
                                    )}
                                    {analysisResult?.description && (
                                        formatDescription(analysisResult.description)
                                    )}
                                </div>
                                
                            </div>
                        )}
                        
                    </div>
                </div>
            </div>
        </div>
    );
};

export default App;
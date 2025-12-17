import { GoogleGenAI, Type, Schema } from "@google/genai";
import { AppConfig, VisionAnalysis, Script, GeneratedVeoData } from "../types";

// --- CẤU HÌNH DANH SÁCH MODEL (Ưu tiên từ trên xuống dưới) ---
const MODEL_PRIORITY = [
  'gemini-2.5-flash',       // Ưu tiên 1: Mới nhất (Có thể chưa ổn định)
  'gemini-2.0-flash',       // Ưu tiên 2: Bản 2.0 Stable
  'gemini-1.5-flash',       // Ưu tiên 3: Bản cũ nhưng cực kỳ trâu bò (Fallback cuối cùng)
];

const getAI = () => new GoogleGenAI({ apiKey: process.env.API_KEY });

// --- HELPER: Delay ---
const delay = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

// --- XỬ LÝ LỖI (Giữ nguyên logic của bạn nhưng tách ra để tái sử dụng) ---
const parseGeminiError = (error: any): string => {
  const errString = JSON.stringify(error) + (error.message || "");
  
  if (errString.includes("429") || errString.includes("Quota exceeded") || errString.includes("RESOURCE_EXHAUSTED")) {
    return "⚠️ Đã hết hạn mức sử dụng miễn phí hoặc Server quá tải. Vui lòng thử lại sau.";
  } 
  if (errString.includes("401") || errString.includes("API_KEY_INVALID")) {
    return "🔑 Lỗi xác thực: API Key không hợp lệ.";
  } 
  if (errString.includes("503") || errString.includes("Overloaded")) {
    return "🐢 Máy chủ AI đang quá tải tạm thời.";
  } 
  if (errString.includes("SAFETY") || errString.includes("BLOCKED")) {
    return "🛡️ Nội dung bị chặn bởi bộ lọc an toàn.";
  } 
  if (errString.includes("404") || errString.includes("not found")) {
    return "❌ Model AI không tồn tại (Sai tên model).";
  }
  return "Đã xảy ra lỗi không xác định khi xử lý.";
};

// --- CORE: HÀM GỌI API THÔNG MINH (FALLBACK LOGIC) ---
/**
 * Hàm này sẽ thử lần lượt các model trong danh sách MODEL_PRIORITY.
 * Nếu gặp lỗi 503/Overloaded/404 -> Tự động chuyển sang model tiếp theo.
 * Nếu gặp lỗi Fatal (401, Safety) -> Dừng ngay lập tức.
 */
const generateWithFallback = async <T>(
  contents: any, 
  schema: Schema, 
  userPromptName: string
): Promise<T> => {
  const ai = getAI();
  let lastError: any = null;

  for (const modelName of MODEL_PRIORITY) {
    try {
      console.log(`🚀 [${userPromptName}] Đang thử model: ${modelName}...`);
      
      const response = await ai.models.generateContent({
        model: modelName,
        contents: contents,
        config: {
          responseMimeType: 'application/json',
          responseSchema: schema
        }
      });

      if (!response.text) throw new Error("API trả về rỗng (No content)");
      
      // Nếu thành công -> Trả về kết quả ngay
      console.log(`✅ [${userPromptName}] Thành công với model: ${modelName}`);
      return JSON.parse(response.text) as T;

    } catch (error: any) {
      lastError = error;
      const errString = JSON.stringify(error) + (error.message || "");
      
      // Chỉ thử lại (Retry) nếu lỗi là 503 (Quá tải) hoặc 404 (Model chưa có ở region này)
      const isRetryable = errString.includes("503") || errString.includes("Overloaded") || errString.includes("404") || errString.includes("not found");

      if (isRetryable) {
        console.warn(`⚠️ [${userPromptName}] Model ${modelName} thất bại (Server Busy/Not Found). Đang chuyển model...`);
        await delay(1000); // Nghỉ 1s trước khi gọi model tiếp theo
        continue; // Chuyển sang vòng lặp tiếp theo (Model kế tiếp)
      } else {
        // Nếu lỗi là 401 (Sai Key), Safety (Vi phạm), 400 (Bad Request) -> Ném lỗi luôn, không thử lại
        console.error(`🛑 [${userPromptName}] Lỗi nghiêm trọng tại ${modelName}:`, error);
        break; 
      }
    }
  }

  // Nếu chạy hết danh sách mà vẫn lỗi -> Ném lỗi cuối cùng ra UI
  const friendlyMessage = parseGeminiError(lastError);
  
  // Log chi tiết cho Dev
  console.group("🚨 GEMINI FINAL ERROR");
  console.error(lastError);
  console.groupEnd();

  throw new Error(`${friendlyMessage} (Đã thử tất cả các model: ${MODEL_PRIORITY.join(', ')})`);
};

// --- Helper: File to Base64 (Giữ nguyên) ---
export const fileToGenerativePart = async (file: File): Promise<string> => {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onloadend = () => {
      const base64String = reader.result as string;
      const base64 = base64String.split(',')[1];
      resolve(base64);
    };
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
};

// =================================================================
// CÁC HÀM NGHIỆP VỤ (Đã được rút gọn nhờ generateWithFallback)
// =================================================================

// --- 1. Vision Analysis ---
export const analyzeProductImage = async (base64Image: string): Promise<VisionAnalysis> => {
  const prompt = `
    Phân tích hình ảnh sản phẩm thời trang này để viết kịch bản video marketing.
    Trích xuất các chi tiết sau dưới dạng JSON (Giá trị trả về phải bằng Tiếng Việt):
    - category: Loại sản phẩm.
    - color_tone: Bảng màu chủ đạo.
    - style: Phong cách thời trang.
    - target_age: Độ tuổi khách hàng mục tiêu ước tính.
    - brand_tone: Giọng điệu thương hiệu gợi ý.
    - usp_highlights: 5 điểm bán hàng độc nhất (USP).
    - tone_scores: Mảng đối tượng {name, value} (0-100).
  `;

  const contents = {
    parts: [
      { inlineData: { mimeType: 'image/jpeg', data: base64Image } },
      { text: prompt }
    ]
  };

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      category: { type: Type.STRING },
      color_tone: { type: Type.STRING },
      style: { type: Type.STRING },
      target_age: { type: Type.STRING },
      brand_tone: { type: Type.STRING },
      usp_highlights: { type: Type.ARRAY, items: { type: Type.STRING } },
      tone_scores: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            value: { type: Type.INTEGER }
          }
        }
      }
    }
  };

  return generateWithFallback<VisionAnalysis>(contents, schema, "Vision Analysis");
};

// --- 2. Generate Scripts ---
export const generateScripts = async (config: AppConfig): Promise<Script[]> => {
  const isNoDialogue = config.videoStyle.includes('Không lời thoại');
  
  const strictRequirements = isNoDialogue
    ? `YÊU CẦU ĐẶC BIỆT: Video KHÔNG LỜI THOẠI. Trường 'dialogue_or_text' chỉ chứa Text Overlay hoặc ghi chú âm nhạc.`
    : `YÊU CẦU: Viết lời thoại tự nhiên, hấp dẫn, phù hợp giọng đọc ${config.accent}.`;

  const prompt = `
    Đóng vai Đạo diễn Video Thời trang. Tạo 5 kịch bản video 30s cho:
    Sản phẩm: ${config.productName}
    Mô tả: ${config.productDescription}
    Vision Data: ${JSON.stringify(config.visionData)}
    Phong cách: ${config.videoStyle}, Loại: ${config.videoType}, Ngôn ngữ: ${config.language}
    
    YÊU CẦU:
    1. ${strictRequirements}
    2. Mỗi kịch bản đúng 3 cảnh.
    3. Trả về mảng JSON.
  `;

  const schema: Schema = {
    type: Type.ARRAY,
    items: {
      type: Type.OBJECT,
      properties: {
        id: { type: Type.STRING },
        title: { type: Type.STRING },
        hook: { type: Type.STRING },
        rationale: { type: Type.STRING },
        benefits_highlighted: { type: Type.ARRAY, items: { type: Type.STRING } },
        cta_overlay: { type: Type.STRING },
        cta_voice: { type: Type.STRING },
        scenes: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              time: { type: Type.STRING },
              action: { type: Type.STRING },
              dialogue_or_text: { type: Type.STRING },
              camera_angle: { type: Type.STRING },
              visual_prompt: { type: Type.STRING },
              music: { type: Type.STRING }
            }
          }
        }
      }
    }
  };

  return generateWithFallback<Script[]>(prompt, schema, "Generate Scripts");
};

// --- 3. Generate Veo-3 Prompt ---
export const generateVeoPrompt = async (script: Script, config: AppConfig): Promise<GeneratedVeoData> => {
  const prompt = `
    Tạo ${script.scenes.length} JSON prompt Tiếng Anh cho model Veo-3 dựa trên kịch bản: "${script.title}".
    Vision Data: ${JSON.stringify(config.visionData)}
    
    YÊU CẦU ENRICHMENT (Thêm chi tiết điện ảnh):
    - Camera: Cinematic dolly, tracking shot...
    - Lighting: Volumetric, golden hour...
    - Motion: Micro-movements...
    - Style: 8k, photorealistic...
    
    Trả về cấu trúc JSON chuẩn cho Veo.
  `;

  // Schema definitions (giữ nguyên cấu trúc của bạn)
  const veoPromptSchema: Schema = {
    type: Type.OBJECT,
    properties: {
      description: { type: Type.STRING },
      style: { type: Type.STRING },
      camera: { type: Type.STRING },
      lighting: { type: Type.STRING },
      environment: { type: Type.STRING },
      characters: {
        type: Type.ARRAY,
        items: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            age: { type: Type.STRING },
            gender: { type: Type.STRING },
            ethnicity: { type: Type.STRING },
            appearance: {
              type: Type.OBJECT,
              properties: { hair: { type: Type.STRING }, expression: { type: Type.STRING }, outfit: { type: Type.STRING } }
            }
          }
        }
      },
      motion: { type: Type.STRING },
      dialogue: { type: Type.ARRAY, items: { type: Type.STRING } },
      ending: { type: Type.STRING },
      text: { type: Type.STRING },
      keywords: { type: Type.ARRAY, items: { type: Type.STRING } },
      aspect_ratio: { type: Type.STRING }
    }
  };

  const schema: Schema = {
    type: Type.OBJECT,
    properties: {
      scenePrompts: { type: Type.ARRAY, items: veoPromptSchema },
      adsCaption: { type: Type.STRING },
      hashtags: { type: Type.ARRAY, items: { type: Type.STRING } },
      ctaVariations: { type: Type.ARRAY, items: { type: Type.STRING } }
    }
  };

  return generateWithFallback<GeneratedVeoData>(prompt, schema, "Veo Prompts");
};
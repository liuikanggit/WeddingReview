use printpdf::*;

pub struct PhotoPage {
    pub file_name: String,
    /// 已经把标注图层叠加合成好的整图原始字节（JPEG 或 PNG）
    pub composite_image: Vec<u8>,
    /// 勾选的清单条目文字（已包含"磨皮"这类内容），按顺序展示
    pub checklist_lines: Vec<String>,
    /// 单张照片的一次性备注
    pub note: String,
}

const PAGE_WIDTH_MM: f32 = 210.0;
const PAGE_HEIGHT_MM: f32 = 297.0;
const MARGIN_MM: f32 = 16.0;
/// 照片可占的最大高度：尽量放大，修图师要看清细节
const PHOTO_BOX_HEIGHT_MM: f32 = 196.0;
const TITLE_SIZE_PT: f32 = 13.0;
const BODY_SIZE_PT: f32 = 10.5;
const BODY_LEADING_PT: f32 = 15.0;
const NOTO_SANS_SC: &[u8] = include_bytes!("../../assets/fonts/NotoSansSC-Regular.ttf");

/// 按可用宽度把一行文本折成多行，避免长备注冲出页面右边缘。
/// 宽度用粗略估算：CJK/全角算一格，ASCII 算半格——排纯文本足够，不必查字体的字形宽度表。
fn wrap_line(text: &str, max_units: f32) -> Vec<String> {
    if max_units <= 0.0 {
        return vec![text.to_string()];
    }
    let mut lines = Vec::new();
    let mut current = String::new();
    let mut width = 0.0;

    for ch in text.chars() {
        let w = if (ch as u32) < 0x2E80 { 0.5 } else { 1.0 };
        if width + w > max_units && !current.is_empty() {
            lines.push(std::mem::take(&mut current));
            width = 0.0;
        }
        current.push(ch);
        width += w;
    }
    if !current.is_empty() {
        lines.push(current);
    }
    if lines.is_empty() {
        lines.push(String::new());
    }
    lines
}

fn text_color(v: f32) -> Color {
    Color::Rgb(Rgb {
        r: v,
        g: v,
        b: v,
        icc_profile: None,
    })
}

/// 给照片描一条浅灰细边——婚纱照多是高调浅色，不描边会和白纸糊在一起
fn photo_border(left: f32, bottom: f32, width: f32, height: f32) -> Vec<Op> {
    let corner = |x: f32, y: f32| LinePoint {
        p: Point::new(Mm(x), Mm(y)),
        bezier: false,
    };
    vec![
        Op::SetOutlineColor {
            col: text_color(0.82),
        },
        Op::SetOutlineThickness { pt: Pt(0.6) },
        Op::DrawPolygon {
            polygon: Polygon {
                rings: vec![PolygonRing {
                    points: vec![
                        corner(left, bottom),
                        corner(left + width, bottom),
                        corner(left + width, bottom + height),
                        corner(left, bottom + height),
                    ],
                }],
                mode: PaintMode::Stroke,
                winding_order: WindingOrder::NonZero,
            },
        },
    ]
}

/// 生成一段文字的排版指令
fn text_block(
    font_id: &FontId,
    lines: &[String],
    x_mm: f32,
    top_mm: f32,
    size_pt: f32,
    leading_pt: f32,
    gray: f32,
) -> Vec<Op> {
    let mut ops = vec![
        Op::StartTextSection,
        Op::SetTextCursor {
            pos: Point::new(Mm(x_mm), Mm(top_mm)),
        },
        Op::SetFont {
            font: PdfFontHandle::External(font_id.clone()),
            size: Pt(size_pt),
        },
        Op::SetLineHeight { lh: Pt(leading_pt) },
        Op::SetFillColor { col: text_color(gray) },
    ];
    for (i, line) in lines.iter().enumerate() {
        if i > 0 {
            ops.push(Op::AddLineBreak);
        }
        ops.push(Op::ShowText {
            items: vec![TextItem::Text(line.clone())],
        });
    }
    ops.push(Op::EndTextSection);
    ops
}

pub fn build_pdf(photos: Vec<PhotoPage>) -> Result<Vec<u8>, String> {
    let mut doc = PdfDocument::new("修图批注");

    let font: ParsedFont = ParsedFont::from_bytes(NOTO_SANS_SC, 0, &mut Vec::new())
        .ok_or_else(|| "中文字体解析失败".to_string())?;
    let font_id = doc.add_font(&font);

    let content_width = PAGE_WIDTH_MM - MARGIN_MM * 2.0;
    let mut pages = Vec::new();

    for photo in photos {
        let mut ops = Vec::new();

        let raw_image = RawImage::decode_from_bytes(&photo.composite_image, &mut Vec::new())
            .map_err(|e| format!("解析照片 {} 失败: {e}", photo.file_name))?;
        let (px_w, px_h) = (raw_image.width as f32, raw_image.height as f32);
        let image_id = doc.add_image(&raw_image);

        // 等比放进「内容宽 × 照片最大高」的框里，并在框内水平居中
        let aspect = px_w / px_h;
        let (draw_w, draw_h) = if aspect >= content_width / PHOTO_BOX_HEIGHT_MM {
            (content_width, content_width / aspect)
        } else {
            (PHOTO_BOX_HEIGHT_MM * aspect, PHOTO_BOX_HEIGHT_MM)
        };

        let image_left = MARGIN_MM + (content_width - draw_w) / 2.0;
        let image_bottom = PAGE_HEIGHT_MM - MARGIN_MM - draw_h;

        ops.push(Op::UseXobject {
            id: image_id,
            transform: XObjectTransform {
                translate_x: Some(Mm(image_left).into()),
                translate_y: Some(Mm(image_bottom).into()),
                // printpdf 用 dpi 决定图片的物理尺寸：物理宽(inch) = 像素宽 / dpi
                dpi: Some(px_w * 25.4 / draw_w),
                ..Default::default()
            },
        });
        ops.extend(photo_border(image_left, image_bottom, draw_w, draw_h));

        // 文件名
        let title_baseline = image_bottom - 9.0;
        ops.extend(text_block(
            &font_id,
            std::slice::from_ref(&photo.file_name),
            MARGIN_MM,
            title_baseline,
            TITLE_SIZE_PT,
            TITLE_SIZE_PT,
            0.1,
        ));

        // 修图要求 + 备注，逐行排版并按页面宽度换行
        let max_units = content_width / (BODY_SIZE_PT * 25.4 / 72.0);
        let mut body: Vec<String> = Vec::new();
        for line in &photo.checklist_lines {
            let wrapped = wrap_line(line, max_units - 1.5);
            for (i, part) in wrapped.iter().enumerate() {
                body.push(if i == 0 {
                    format!("· {part}")
                } else {
                    format!("   {part}")
                });
            }
        }
        if !photo.note.trim().is_empty() {
            for raw in photo.note.lines() {
                if raw.trim().is_empty() {
                    continue;
                }
                let wrapped = wrap_line(raw, max_units - 3.0);
                for (i, part) in wrapped.iter().enumerate() {
                    body.push(if i == 0 {
                        format!("备注：{part}")
                    } else {
                        format!("      {part}")
                    });
                }
            }
        }
        if body.is_empty() {
            body.push("（无修图要求）".to_string());
        }

        // 首页照片下方能放多少行，放不下的转到续页——修图要求不能因为排版而丢失
        let line_mm = BODY_LEADING_PT * 25.4 / 72.0;
        let body_top = title_baseline - 8.0;
        let first_page_lines = ((body_top - MARGIN_MM) / line_mm).floor().max(0.0) as usize;

        let rest = if body.len() > first_page_lines {
            body.split_off(first_page_lines)
        } else {
            Vec::new()
        };

        ops.extend(text_block(
            &font_id,
            &body,
            MARGIN_MM,
            body_top,
            BODY_SIZE_PT,
            BODY_LEADING_PT,
            0.2,
        ));
        pages.push(PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), ops));

        // 续页：只排文字，一页放满再开下一页
        let cont_top = PAGE_HEIGHT_MM - MARGIN_MM;
        let cont_title_gap = 9.0;
        let cont_capacity = ((cont_top - cont_title_gap - MARGIN_MM) / line_mm).floor().max(1.0) as usize;
        for chunk in rest.chunks(cont_capacity) {
            let mut cont_ops = text_block(
                &font_id,
                std::slice::from_ref(&format!("{}（续）", photo.file_name)),
                MARGIN_MM,
                cont_top,
                TITLE_SIZE_PT,
                TITLE_SIZE_PT,
                0.1,
            );
            cont_ops.extend(text_block(
                &font_id,
                chunk,
                MARGIN_MM,
                cont_top - cont_title_gap,
                BODY_SIZE_PT,
                BODY_LEADING_PT,
                0.2,
            ));
            pages.push(PdfPage::new(Mm(PAGE_WIDTH_MM), Mm(PAGE_HEIGHT_MM), cont_ops));
        }
    }

    let mut options = PdfSaveOptions::default();
    options.subset_fonts = true;

    let mut warnings = Vec::new();
    Ok(doc.with_pages(pages).save(&options, &mut warnings))
}

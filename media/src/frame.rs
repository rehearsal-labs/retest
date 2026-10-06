//! Turns captured images into what the encoder, a thumbnail, a frame sequence or a live view needs.
//!
//! A frame of another size is scaled to fit the recording with its proportions kept and centred on black, so a
//! page is never stretched. Images are decoded here before admission on every route. Thumbnails, frame sequences
//! and live views are fitted within their size and never enlarged; an image that already fits and is already in the
//! wanted format keeps its original bytes after that decode check.
//! Video input is sRGB. Embedded RGB matrix/TRC ICC profiles with a D50 XYZ connection space are converted before
//! fitting or encoding, including matching-format video frames. Unsupported or malformed profiles are refused.

use std::io::Cursor;

use image::codecs::jpeg::JpegEncoder;
use image::codecs::png::{CompressionType, FilterType as PngFilter, PngEncoder};
use image::imageops::{self, FilterType};
use image::{DynamicImage, ImageDecoder, ImageError, ImageFormat, ImageReader, Limits, RgbImage};

use crate::protocol::FrameFormat;

/// The widest or tallest image a recording's frame may be. Larger ones are refused before their pixels are allocated.
const MAX_SIDE: u32 = 16_384;
const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;
/// A thumbnail's source is held to tighter bounds: one image, decoded on a shared worker.
pub const STILL_MAX_SIDE: u32 = 16_384;
pub const STILL_MAX_DECODE_BYTES: u64 = 256 * 1024 * 1024;
/// The quality of JPEG frames the encoded route writes for frames that had to be converted.
const ROUTE_JPEG_QUALITY: u8 = 90;

/// A frame's pixels at the recording's size, three bytes per pixel, rows top to bottom.
#[derive(Debug)]
pub struct Pixels {
    pub rgb: Vec<u8>,
    pub resized: bool,
    pub source_width: u32,
    pub source_height: u32,
}

/// Why an image could not be used.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ImageFailure {
    /// The bytes are not a readable image of their format.
    Undecodable(String),
    /// The image is larger than the limits allow.
    TooLarge(String),
}

impl ImageFailure {
    pub fn message(&self) -> &str {
        match self {
            ImageFailure::Undecodable(message) | ImageFailure::TooLarge(message) => message,
        }
    }
}

fn image_format(format: FrameFormat) -> ImageFormat {
    match format {
        FrameFormat::Png => ImageFormat::Png,
        FrameFormat::Jpeg => ImageFormat::Jpeg,
    }
}

/// Decodes an image within the given bounds on its sides and on what decoding may allocate.
pub fn decode_image(
    bytes: &[u8],
    format: FrameFormat,
    max_side: u32,
    max_bytes: u64,
) -> Result<DynamicImage, ImageFailure> {
    decoded_image(bytes, format, max_side, max_bytes).map(|(image, _)| image)
}

// The bool says an ICC profile was present. Encoded video admission cannot forward such bytes unchanged:
// ffmpeg's image decoder does not apply that profile, so both recording routes receive normalized sRGB.
fn decoded_image(
    bytes: &[u8],
    format: FrameFormat,
    max_side: u32,
    max_bytes: u64,
) -> Result<(DynamicImage, bool), ImageFailure> {
    let mut reader = ImageReader::with_format(Cursor::new(bytes), image_format(format));
    let mut limits = Limits::default();
    limits.max_image_width = Some(max_side);
    limits.max_image_height = Some(max_side);
    limits.max_alloc = Some(max_bytes);
    reader.limits(limits);
    let decode_failure = |error| match error {
        ImageError::Limits(limits) => ImageFailure::TooLarge(limits.to_string()),
        other => ImageFailure::Undecodable(other.to_string()),
    };
    let mut decoder = reader.into_decoder().map_err(decode_failure)?;
    if decoder.total_bytes() > max_bytes {
        return Err(ImageFailure::TooLarge(
            "the decoded pixels exceed the allocation limit".to_owned(),
        ));
    }
    let profile = decoder.icc_profile().map_err(decode_failure)?;
    let mut image = DynamicImage::from_decoder(decoder).map_err(decode_failure)?;
    if let Some(profile) = &profile {
        normalize_icc(&mut image, profile).map_err(ImageFailure::Undecodable)?;
    }
    Ok((image, profile.is_some()))
}

// ICC RGB matrix/TRC profiles use D50 XYZ as their connection space. Convert those intended colours to
// encoded sRGB before resizing or removing the profile. LUT profiles require a different transform and are
// refused rather than silently interpreted as sRGB. Formula source: https://registry.color.org/rgb-registry/files/sRGB.pdf
fn normalize_icc(image: &mut DynamicImage, profile: &[u8]) -> Result<(), String> {
    let invalid = || {
        "the embedded ICC profile is malformed or unsupported; RGB matrix/TRC with D50 XYZ is required".to_owned()
    };
    let read_u32 = |bytes: &[u8], offset: usize| -> Option<u32> {
        Some(u32::from_be_bytes(
            bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
        ))
    };
    let fixed = |bytes: &[u8], offset: usize| -> Option<f64> {
        Some(f64::from(read_u32(bytes, offset)? as i32) / 65536.0)
    };
    if image.color().channel_count() < 3
        || read_u32(profile, 0).map(|size| size as usize) != Some(profile.len())
        || !matches!(profile.get(8), Some(2 | 4))
        || !matches!(profile.get(12..16), Some(b"mntr" | b"scnr" | b"spac"))
        || profile.get(16..24) != Some(b"RGB XYZ ")
        || profile.get(36..40) != Some(b"acsp")
    {
        return Err(invalid());
    }
    for (offset, expected) in [(68, 0.9642), (72, 1.0), (76, 0.8249)] {
        if fixed(profile, offset).is_none_or(|actual| (actual - expected).abs() > 0.001) {
            return Err(invalid());
        }
    }
    let count = read_u32(profile, 128).ok_or_else(invalid)? as usize;
    if count > 4096 || 132 + count * 12 > profile.len() {
        return Err(invalid());
    }
    let mut tags = std::collections::BTreeMap::new();
    for entry in 0..count {
        let start = 132 + entry * 12;
        let signature = &profile[start..start + 4];
        let offset = read_u32(profile, start + 4).ok_or_else(invalid)? as usize;
        let size = read_u32(profile, start + 8).ok_or_else(invalid)? as usize;
        let end = offset.checked_add(size).ok_or_else(invalid)?;
        if offset < 132 + count * 12
            || end > profile.len()
            || size < 8
            || signature.starts_with(b"A2B")
            || signature.starts_with(b"D2B")
            || tags.insert(signature, &profile[offset..end]).is_some()
        {
            return Err(invalid());
        }
    }
    let tag = |signature: &[u8]| tags.get(signature).copied().ok_or_else(invalid);
    let mut xyz = [[0.0_f64; 3]; 3];
    let mut curves = [[0.0_f64; 256]; 3];
    for (channel, (matrix, curve)) in [(b"rXYZ", b"rTRC"), (b"gXYZ", b"gTRC"), (b"bXYZ", b"bTRC")]
        .into_iter()
        .enumerate()
    {
        let values = tag(matrix)?;
        if values.get(..4) != Some(b"XYZ ") || values.len() != 20 {
            return Err(invalid());
        }
        for (row, output) in xyz.iter_mut().enumerate() {
            output[channel] = fixed(values, 8 + row * 4).ok_or_else(invalid)?;
        }
        curves[channel] = icc_curve(tag(curve)?).ok_or_else(invalid)?;
    }
    // Inverse of the D50-adapted sRGB primary matrix, including adaptation back to D65.
    let xyz_to_srgb = [
        [3.1338561, -1.6168667, -0.4906146],
        [-0.9787684, 1.9161415, 0.0334540],
        [0.0719453, -0.2289914, 1.4052427],
    ];
    let mut matrix = [[0.0; 3]; 3];
    for (row, output) in matrix.iter_mut().enumerate() {
        for (channel, coefficient) in output.iter_mut().enumerate() {
            *coefficient = (0..3)
                .map(|axis| xyz_to_srgb[row][axis] * xyz[axis][channel])
                .sum();
        }
    }
    let transform = |pixel: &mut [u8]| {
        let linear = [
            curves[0][usize::from(pixel[0])],
            curves[1][usize::from(pixel[1])],
            curves[2][usize::from(pixel[2])],
        ];
        for channel in 0..3 {
            let value: f64 = (0..3)
                .map(|axis| matrix[channel][axis] * linear[axis])
                .sum();
            let value = value.clamp(0.0, 1.0);
            let encoded = if value <= 0.0031308 {
                12.92 * value
            } else {
                1.055 * value.powf(1.0 / 2.4) - 0.055
            };
            pixel[channel] = (encoded * 255.0).round() as u8;
        }
    };
    match image {
        DynamicImage::ImageRgb8(rgb) => rgb
            .as_mut()
            .as_chunks_mut::<3>()
            .0
            .iter_mut()
            .for_each(|pixel| transform(pixel)),
        DynamicImage::ImageRgba8(rgba) => rgba
            .as_mut()
            .as_chunks_mut::<4>()
            .0
            .iter_mut()
            .for_each(|pixel| transform(pixel)),
        _ => {
            let mut rgba = image.to_rgba8();
            rgba.as_mut()
                .as_chunks_mut::<4>()
                .0
                .iter_mut()
                .for_each(|pixel| transform(pixel));
            *image = DynamicImage::ImageRgba8(rgba);
        }
    }
    image
        .set_color_space(image::metadata::Cicp::SRGB)
        .map_err(|error| error.to_string())?;
    Ok(())
}

// Sample the ICC channel curve at each possible 8-bit input. Table curves are interpolated; parametric
// curves implement ICC types 0 through 4. Invalid curves cannot turn into a usable frame.
fn icc_curve(bytes: &[u8]) -> Option<[f64; 256]> {
    let u16_at = |offset: usize| {
        Some(u16::from_be_bytes(
            bytes.get(offset..offset.checked_add(2)?)?.try_into().ok()?,
        ))
    };
    let u32_at = |offset: usize| {
        Some(u32::from_be_bytes(
            bytes.get(offset..offset.checked_add(4)?)?.try_into().ok()?,
        ))
    };
    let mut table = [0.0; 256];
    match bytes.get(..4)? {
        b"curv" => {
            let count = u32_at(8)? as usize;
            if count > 65_536 || bytes.len() < 12 + count * 2 {
                return None;
            }
            if count > 1 {
                for index in 1..count {
                    if u16_at(12 + index * 2)? < u16_at(12 + (index - 1) * 2)? {
                        return None;
                    }
                }
            }
            for (index, value) in table.iter_mut().enumerate() {
                let x = index as f64 / 255.0;
                *value = match count {
                    0 => x,
                    1 => {
                        let gamma = f64::from(u16_at(12)?) / 256.0;
                        if gamma <= 0.0 {
                            return None;
                        }
                        x.powf(gamma)
                    }
                    _ => {
                        let at = x * (count - 1) as f64;
                        let left = at.floor() as usize;
                        let right = (left + 1).min(count - 1);
                        let a = f64::from(u16_at(12 + left * 2)?);
                        let b = f64::from(u16_at(12 + right * 2)?);
                        (a + (b - a) * (at - left as f64)) / 65535.0
                    }
                };
            }
        }
        b"para" => {
            let kind = u16_at(8)?;
            let count = *[1, 3, 4, 5, 7].get(usize::from(kind))?;
            let mut p = [0.0; 7];
            for (index, value) in p.iter_mut().take(count).enumerate() {
                *value = f64::from(u32_at(12 + index * 4)? as i32) / 65536.0;
            }
            let [g, a, b, c, d, e, f] = p;
            if g <= 0.0 || (kind > 0 && a <= 0.0) {
                return None;
            }
            for (index, value) in table.iter_mut().enumerate() {
                let x = index as f64 / 255.0;
                *value = match kind {
                    0 => x.powf(g),
                    1 => {
                        if x >= -b / a {
                            (a * x + b).powf(g)
                        } else {
                            0.0
                        }
                    }
                    2 => {
                        if x >= -b / a {
                            (a * x + b).powf(g) + c
                        } else {
                            c
                        }
                    }
                    3 => {
                        if x >= d {
                            (a * x + b).powf(g)
                        } else {
                            c * x
                        }
                    }
                    4 => {
                        if x >= d {
                            (a * x + b).powf(g) + e
                        } else {
                            c * x + f
                        }
                    }
                    _ => return None,
                };
            }
        }
        _ => return None,
    }
    if table
        .iter()
        .any(|value| !value.is_finite() || *value < -0.001 || *value > 1.001)
        || table.windows(2).any(|pair| pair[0] > pair[1])
    {
        return None;
    }
    Some(table)
}

/// The size an image says it is, read from its header without decoding its pixels.
pub fn dimensions(bytes: &[u8], format: FrameFormat) -> Result<(u32, u32), String> {
    ImageReader::with_format(Cursor::new(bytes), image_format(format))
        .into_dimensions()
        .map_err(|error| error.to_string())
}

/// Decodes a recording's frame to raw RGB at the recording's size, fitting and centring one of another size.
pub fn decode(
    bytes: &[u8],
    format: FrameFormat,
    width: u32,
    height: u32,
) -> Result<Pixels, String> {
    let image = decode_image(bytes, format, MAX_SIDE, MAX_DECODE_BYTES)
        .map_err(|failure| failure.message().to_owned())?;
    Ok(onto_canvas(image, width, height))
}

fn onto_canvas(image: DynamicImage, width: u32, height: u32) -> Pixels {
    let (source_width, source_height) = (image.width(), image.height());
    if source_width == width && source_height == height {
        return Pixels {
            rgb: image.into_rgb8().into_raw(),
            resized: false,
            source_width,
            source_height,
        };
    }
    let scaled = image
        .resize(width, height, FilterType::Triangle)
        .into_rgb8();
    let mut canvas = RgbImage::new(width, height);
    let left = (width - scaled.width().min(width)) / 2;
    let top = (height - scaled.height().min(height)) / 2;
    imageops::replace(&mut canvas, &scaled, i64::from(left), i64::from(top));
    Pixels {
        rgb: canvas.into_raw(),
        resized: true,
        source_width,
        source_height,
    }
}

/// A frame for the encoded route: unprofiled bytes as they came when already in the route's format at the
/// recording's size, or the frame decoded to sRGB, fitted and encoded in that format otherwise.
pub struct RouteFrame {
    pub bytes: Option<Vec<u8>>,
    pub resized: bool,
    pub source_width: u32,
    pub source_height: u32,
}

/// Readies one frame for the encoded route. `None` in `bytes` means the frame goes as it came. Such a frame is still
/// decoded once, and its pixels let go: a header can be whole over image data cut short, and a frame ffmpeg cannot
/// decode would otherwise be counted shown while the video repeats the frame before it.
/// A profiled frame is always converted because ffmpeg does not apply the embedded ICC transform.
pub fn for_route(
    bytes: &[u8],
    format: FrameFormat,
    route: FrameFormat,
    width: u32,
    height: u32,
) -> Result<RouteFrame, String> {
    let source_size = dimensions(bytes, format)?;
    let matching = format == route && source_size == (width, height);
    let budget = if matching {
        STILL_MAX_DECODE_BYTES
    } else {
        MAX_DECODE_BYTES
    };
    let (image, profiled) = decoded_image(bytes, format, MAX_SIDE, budget)
        .map_err(|failure| failure.message().to_owned())?;
    let (source_width, source_height) = (image.width(), image.height());
    if !profiled && format == route && (source_width, source_height) == (width, height) {
        return Ok(RouteFrame {
            bytes: None,
            resized: false,
            source_width,
            source_height,
        });
    }
    let pixels = onto_canvas(image, width, height);
    let image = RgbImage::from_raw(width, height, pixels.rgb)
        .ok_or_else(|| "the fitted frame had the wrong size".to_owned())?;
    let encoded = encode(&DynamicImage::ImageRgb8(image), route, ROUTE_JPEG_QUALITY)?;
    Ok(RouteFrame {
        bytes: Some(encoded),
        resized: pixels.resized,
        source_width,
        source_height,
    })
}

/// The largest size of `width` by `height` that fits within the maximum and keeps the proportions; never larger
/// than the image, and at least one pixel each way.
pub fn fit_within(width: u32, height: u32, max_width: u32, max_height: u32) -> (u32, u32) {
    if width <= max_width && height <= max_height {
        return (width.max(1), height.max(1));
    }
    let scale = f64::min(
        f64::from(max_width) / f64::from(width),
        f64::from(max_height) / f64::from(height),
    );
    let fitted = |side: u32, limit: u32| -> u32 {
        // Rounding can step one past the limit; the limit wins.
        let value = (f64::from(side) * scale).round();
        (value as u32).clamp(1, limit)
    };
    (fitted(width, max_width), fitted(height, max_height))
}

/// Encodes pixels in `format`, JPEG at `quality` from 1 to 100.
pub fn encode(image: &DynamicImage, format: FrameFormat, quality: u8) -> Result<Vec<u8>, String> {
    let mut bytes = Vec::new();
    let rgb = DynamicImage::ImageRgb8(image.to_rgb8());
    let written = match format {
        FrameFormat::Jpeg => rgb.write_with_encoder(JpegEncoder::new_with_quality(
            &mut bytes,
            quality.clamp(1, 100),
        )),
        FrameFormat::Png => rgb.write_with_encoder(PngEncoder::new_with_quality(
            &mut bytes,
            CompressionType::Fast,
            PngFilter::Adaptive,
        )),
    };
    written.map_err(|error| error.to_string())?;
    Ok(bytes)
}

/// An image fitted within a size, in a format, with the size it had.
#[derive(Debug)]
pub struct Fitted {
    pub bytes: Vec<u8>,
    pub width: u32,
    pub height: u32,
    pub source_width: u32,
    pub source_height: u32,
}

/// What `fit` is asked for: the largest size, the format and the JPEG quality of the result, and the bounds the
/// source must stay within to be decoded.
#[derive(Debug, Clone, Copy)]
pub struct FitRequest {
    pub max_width: u32,
    pub max_height: u32,
    pub format: FrameFormat,
    pub quality: u8,
    pub max_side: u32,
    pub max_decode_bytes: u64,
}

/// Fits one image within a size, never enlarging it. An image that fits already and is in the wanted format is
/// returned as it came after its pixels have been decoded within the bounds, as on the recording route.
pub fn fit(
    bytes: &[u8],
    source_format: FrameFormat,
    request: FitRequest,
) -> Result<Fitted, ImageFailure> {
    let (source_width, source_height) =
        dimensions(bytes, source_format).map_err(ImageFailure::Undecodable)?;
    if source_width > request.max_side || source_height > request.max_side {
        return Err(ImageFailure::TooLarge(format!(
            "the image is {source_width} by {source_height}; at most {} on each side is decoded",
            request.max_side
        )));
    }
    let (width, height) = fit_within(
        source_width,
        source_height,
        request.max_width,
        request.max_height,
    );
    // The same bounded decode check used by the recording route also applies to matching-format fast paths.
    let image = decode_image(
        bytes,
        source_format,
        request.max_side,
        request.max_decode_bytes,
    )?;
    if source_format == request.format && (width, height) == (source_width, source_height) {
        return Ok(Fitted {
            bytes: bytes.to_vec(),
            width,
            height,
            source_width,
            source_height,
        });
    }
    let resized = if (width, height) == (image.width(), image.height()) {
        image
    } else {
        image.resize_exact(width, height, FilterType::Triangle)
    };
    let encoded =
        encode(&resized, request.format, request.quality).map_err(ImageFailure::Undecodable)?;
    Ok(Fitted {
        bytes: encoded,
        width,
        height,
        source_width,
        source_height,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{ImageEncoder, Rgb};

    // Original RGB matrix/TRC fixture: sRGB primaries adapted to D50, but linear channel values.
    // A 128 channel therefore means half linear light, which is 188 in encoded sRGB.
    fn linear_rgb_profile() -> Vec<u8> {
        let mut profile = vec![0_u8; 132 + 9 * 12];
        profile[8] = 4;
        profile[12..16].copy_from_slice(b"mntr");
        profile[16..20].copy_from_slice(b"RGB ");
        profile[20..24].copy_from_slice(b"XYZ ");
        profile[36..40].copy_from_slice(b"acsp");
        for (index, value) in [2026_u16, 1, 1, 0, 0, 0].into_iter().enumerate() {
            profile[24 + index * 2..26 + index * 2].copy_from_slice(&value.to_be_bytes());
        }
        profile[64..68].copy_from_slice(&1_u32.to_be_bytes());
        for (offset, value) in [(68, 0.9642_f64), (72, 1.0), (76, 0.8249)] {
            profile[offset..offset + 4]
                .copy_from_slice(&((value * 65536.0).round() as i32).to_be_bytes());
        }
        profile[128..132].copy_from_slice(&9_u32.to_be_bytes());
        for (index, (signature, values)) in [
            (b"rXYZ", [0.4360747_f64, 0.2225045, 0.0139322]),
            (b"gXYZ", [0.3850649, 0.7168786, 0.0971045]),
            (b"bXYZ", [0.1430804, 0.0606169, 0.7141733]),
        ]
        .into_iter()
        .enumerate()
        {
            let offset = profile.len() as u32;
            profile[132 + index * 12..136 + index * 12].copy_from_slice(signature);
            profile[136 + index * 12..140 + index * 12].copy_from_slice(&offset.to_be_bytes());
            profile[140 + index * 12..144 + index * 12].copy_from_slice(&20_u32.to_be_bytes());
            profile.extend_from_slice(b"XYZ \0\0\0\0");
            for value in values {
                profile.extend_from_slice(&((value * 65536.0).round() as i32).to_be_bytes());
            }
        }
        for (index, signature) in [b"rTRC", b"gTRC", b"bTRC"].into_iter().enumerate() {
            let index = index + 3;
            let offset = profile.len() as u32;
            profile[132 + index * 12..136 + index * 12].copy_from_slice(signature);
            profile[136 + index * 12..140 + index * 12].copy_from_slice(&offset.to_be_bytes());
            profile[140 + index * 12..144 + index * 12].copy_from_slice(&12_u32.to_be_bytes());
            profile.extend_from_slice(b"curv\0\0\0\0\0\0\0\0");
        }
        let mut white = b"XYZ \0\0\0\0".to_vec();
        for value in [0.9642_f64, 1.0, 0.8249] {
            white.extend_from_slice(&((value * 65536.0).round() as i32).to_be_bytes());
        }
        let text_tag = |text: &str| {
            let text: Vec<u8> = text.encode_utf16().flat_map(u16::to_be_bytes).collect();
            let mut data = b"mluc\0\0\0\0".to_vec();
            data.extend_from_slice(&1_u32.to_be_bytes());
            data.extend_from_slice(&12_u32.to_be_bytes());
            data.extend_from_slice(b"enUS");
            data.extend_from_slice(&(text.len() as u32).to_be_bytes());
            data.extend_from_slice(&28_u32.to_be_bytes());
            data.extend_from_slice(&text);
            data
        };
        for (index, (signature, data)) in [
            (b"wtpt", white),
            (b"desc", text_tag("Retest linear RGB test profile")),
            (b"cprt", text_tag("Original Retest test fixture")),
        ]
        .into_iter()
        .enumerate()
        {
            let index = index + 6;
            while !profile.len().is_multiple_of(4) {
                profile.push(0);
            }
            let offset = profile.len() as u32;
            profile[132 + index * 12..136 + index * 12].copy_from_slice(signature);
            profile[136 + index * 12..140 + index * 12].copy_from_slice(&offset.to_be_bytes());
            profile[140 + index * 12..144 + index * 12]
                .copy_from_slice(&(data.len() as u32).to_be_bytes());
            profile.extend_from_slice(&data);
        }
        while !profile.len().is_multiple_of(4) {
            profile.push(0);
        }
        let size = profile.len() as u32;
        profile[..4].copy_from_slice(&size.to_be_bytes());
        profile
    }

    fn profiled_jpeg() -> Vec<u8> {
        let mut bytes = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut bytes, 100);
        encoder
            .set_icc_profile(linear_rgb_profile())
            .expect("profile accepted");
        encoder
            .encode_image(&RgbImage::from_pixel(16, 16, Rgb([0, 128, 0])))
            .expect("encodes");
        bytes
    }

    fn assert_linear_green_is_srgb(rgb: &[u8]) {
        // JPEG rounds the source blue channel from 0 to 1. Linear 1/255 becomes encoded sRGB 13.
        assert!(
            rgb[0] < 5 && rgb[1].abs_diff(188) <= 3 && rgb[2].abs_diff(13) <= 3,
            "linear RGB JPEG green must become sRGB [0,188,13], got {:?}",
            &rgb[..3]
        );
    }

    #[test]
    fn a_profiled_jpeg_normalizes_its_intended_colour_before_raw_admission_and_resize() {
        let jpeg = profiled_jpeg();
        let stored = image::load_from_memory_with_format(&jpeg, ImageFormat::Jpeg)
            .expect("source decodes")
            .into_rgb8();
        assert_eq!(
            stored.get_pixel(0, 0).0,
            [0, 128, 1],
            "known JPEG witness before profile conversion"
        );
        for (width, height) in [(16, 16), (8, 8)] {
            let pixels = decode(&jpeg, FrameFormat::Jpeg, width, height).expect("decodes");
            assert_linear_green_is_srgb(&pixels.rgb);
        }
    }

    #[test]
    fn a_profiled_jpeg_normalizes_even_on_the_matching_encoded_route() {
        let jpeg = profiled_jpeg();
        for (width, height) in [(16, 16), (8, 8)] {
            let frame = for_route(&jpeg, FrameFormat::Jpeg, FrameFormat::Jpeg, width, height)
                .expect("ready");
            let normalized = frame
                .bytes
                .expect("ffmpeg must receive normalized sRGB, not the original profile channels");
            let pixels = decode(&normalized, FrameFormat::Jpeg, width, height).expect("decodes");
            assert_linear_green_is_srgb(&pixels.rgb);
        }
    }

    #[test]
    fn malformed_or_unsupported_profiles_are_refused_on_every_converted_route() {
        let valid = linear_rgb_profile();
        let mut truncated = valid.clone();
        truncated.truncate(140);
        let mut lut = valid.clone();
        lut[132..136].copy_from_slice(b"A2B0");
        let mut bad_curve = valid.clone();
        // The fourth tag is rTRC; refuse a curve claiming samples beyond its tag.
        let curve_offset =
            u32::from_be_bytes(bad_curve[172..176].try_into().expect("curve offset")) as usize;
        bad_curve[curve_offset + 8..curve_offset + 12].copy_from_slice(&1000_u32.to_be_bytes());
        for profile in [truncated, lut, bad_curve] {
            let mut jpeg = Vec::new();
            let mut encoder = JpegEncoder::new_with_quality(&mut jpeg, 100);
            encoder
                .set_icc_profile(profile)
                .expect("profile accepted by encoder");
            encoder
                .encode_image(&RgbImage::from_pixel(16, 16, Rgb([0, 128, 0])))
                .expect("encodes");
            assert!(
                decode(&jpeg, FrameFormat::Jpeg, 16, 16)
                    .expect_err("raw refused")
                    .contains("ICC profile")
            );
            assert!(
                for_route(&jpeg, FrameFormat::Jpeg, FrameFormat::Jpeg, 16, 16)
                    .err()
                    .expect("encoded refused")
                    .contains("ICC profile")
            );
            assert!(
                fit(&jpeg, FrameFormat::Jpeg, request(8, 8, FrameFormat::Png))
                    .expect_err("fit refused")
                    .message()
                    .contains("ICC profile")
            );
        }
        let mut gray = Vec::new();
        let mut encoder = JpegEncoder::new_with_quality(&mut gray, 100);
        encoder.set_icc_profile(valid).expect("profile attached");
        encoder
            .encode_image(&image::GrayImage::new(16, 16))
            .expect("grayscale JPEG");
        assert!(
            decode(&gray, FrameFormat::Jpeg, 16, 16)
                .expect_err("RGB profile on grayscale refused")
                .contains("ICC profile")
        );
    }

    #[test]
    fn icc_channel_curves_validate_and_interpolate_their_defined_values() {
        let mut curve = b"curv\0\0\0\0\0\0\0\x03".to_vec();
        for value in [0_u16, 32768, 65535] {
            curve.extend_from_slice(&value.to_be_bytes());
        }
        let table = icc_curve(&curve).expect("table curve");
        assert_eq!([table[0], table[255]], [0.0, 1.0]);
        assert!((table[128] - 128.0 / 255.0).abs() < 0.00002);
        curve[14..16].copy_from_slice(&65535_u16.to_be_bytes());
        curve[16..18].copy_from_slice(&1_u16.to_be_bytes());
        assert!(icc_curve(&curve).is_none(), "decreasing table refused");
        for (kind, parameters) in [
            (0_u16, vec![1.0_f64]),
            (1, vec![1.0, 1.0, 0.0]),
            (2, vec![1.0, 1.0, 0.0, 0.0]),
            (3, vec![1.0, 1.0, 0.0, 1.0, 0.5]),
            (4, vec![1.0, 1.0, 0.0, 1.0, 0.5, 0.0, 0.0]),
        ] {
            let mut curve = b"para\0\0\0\0".to_vec();
            curve.extend_from_slice(&kind.to_be_bytes());
            curve.extend_from_slice(&[0, 0]);
            for value in parameters {
                curve.extend_from_slice(&((value * 65536.0).round() as i32).to_be_bytes());
            }
            let table = icc_curve(&curve).expect("parametric curve");
            for (index, value) in table.iter().enumerate() {
                assert!((value - index as f64 / 255.0).abs() < 1e-10);
            }
        }
    }

    #[test]
    fn a_profiled_jpeg_keeps_its_intended_colour_in_a_real_ffmpeg_video() {
        use std::io::Write;
        use std::process::{Command, Stdio};

        // This witness requires ffmpeg with libx264, mjpeg/h264/rawvideo decoders, and image2pipe/rawvideo/MP4
        // support. Only an actually absent executable skips it. An installed tool's failed probe or conversion
        // remains a test failure, including a build without the required codec.
        let requested = std::env::var_os("RETEST_FFMPEG").unwrap_or_else(|| "ffmpeg".into());
        let path = std::path::Path::new(&requested);
        let candidates: Vec<std::path::PathBuf> = if path.components().count() > 1 {
            vec![path.to_owned()]
        } else {
            std::env::split_paths(
                &std::env::var_os("PATH").expect("PATH for the ffmpeg prerequisite"),
            )
            .map(|folder| folder.join(path))
            .collect()
        };
        let ffmpeg = candidates
            .into_iter()
            .find(|candidate| match std::fs::metadata(candidate) {
                Ok(_) => true,
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
                Err(error) => panic!(
                    "could not inspect the ffmpeg prerequisite {}: {error}",
                    candidate.display()
                ),
            });
        let Some(ffmpeg) = ffmpeg else {
            // Write to the real descriptor so the named prerequisite skip remains visible in an ordinary Cargo
            // run, whose successful-test output libtest otherwise captures. Libtest counts this return as ok.
            writeln!(std::io::stderr().lock(), "SKIP frame::tests::a_profiled_jpeg_keeps_its_intended_colour_in_a_real_ffmpeg_video: ffmpeg executable {} is absent; requires libx264, mjpeg/h264/rawvideo decoders and image2pipe/rawvideo/MP4 support", path.display()).expect("report the named prerequisite skip");
            return;
        };
        let encoders = Command::new(&ffmpeg)
            .args(["-hide_banner", "-encoders"])
            .output()
            .expect("installed ffmpeg encoder listing must start");
        assert!(
            encoders.status.success(),
            "installed ffmpeg encoder listing failed: {}",
            String::from_utf8_lossy(&encoders.stderr)
        );
        assert!(
            String::from_utf8_lossy(&encoders.stdout)
                .lines()
                .any(|line| line.split_whitespace().nth(1) == Some("libx264")),
            "the colour witness requires ffmpeg's libx264 encoder; an installed ffmpeg without it cannot skip this test"
        );
        let run = |args: &[&str], input: &[u8]| {
            let mut child = Command::new(&ffmpeg)
                .args(args)
                .stdin(Stdio::piped())
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .spawn()
                .expect("declared ffmpeg prerequisite");
            let mut stdin = child.stdin.take().expect("stdin");
            let written = stdin.write_all(input);
            drop(stdin);
            let output = child.wait_with_output().expect("reap owned ffmpeg child");
            assert!(
                output.status.success(),
                "ffmpeg failed: {}",
                String::from_utf8_lossy(&output.stderr)
            );
            written.expect("input written to installed ffmpeg");
            output.stdout
        };
        let jpeg = profiled_jpeg();
        for (width, height) in [(16, 16), (8, 8)] {
            for encoded_route in [true, false] {
                let size = format!("{width}x{height}");
                let mut args = vec!["-v", "error", "-xerror"];
                let input = if encoded_route {
                    args.extend(["-f", "image2pipe", "-c:v", "mjpeg", "-i", "pipe:0"]);
                    for_route(&jpeg, FrameFormat::Jpeg, FrameFormat::Jpeg, width, height)
                        .expect("ready")
                        .bytes
                        .expect("normalized JPEG")
                } else {
                    args.extend([
                        "-f", "rawvideo", "-pix_fmt", "rgb24", "-s", &size, "-i", "pipe:0",
                    ]);
                    decode(&jpeg, FrameFormat::Jpeg, width, height)
                        .expect("normalized raw pixels")
                        .rgb
                };
                args.extend([
                    "-frames:v",
                    "1",
                    "-c:v",
                    "libx264",
                    "-crf",
                    "0",
                    "-pix_fmt",
                    "yuv444p",
                    "-movflags",
                    "frag_keyframe+empty_moov",
                    "-f",
                    "mp4",
                    "pipe:1",
                ]);
                let video = run(&args, &input);
                let pixels = run(
                    &[
                        "-v", "error", "-xerror", "-i", "pipe:0", "-pix_fmt", "rgb24", "-f",
                        "rawvideo", "pipe:1",
                    ],
                    &video,
                );
                assert_eq!(pixels.len(), width as usize * height as usize * 3);
                assert_linear_green_is_srgb(&pixels);
            }
        }
    }

    fn encoded(image: RgbImage, format: ImageFormat) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, format)
            .expect("encodes");
        bytes.into_inner()
    }

    fn request(max_width: u32, max_height: u32, format: FrameFormat) -> FitRequest {
        FitRequest {
            max_width,
            max_height,
            format,
            quality: 80,
            max_side: STILL_MAX_SIDE,
            max_decode_bytes: STILL_MAX_DECODE_BYTES,
        }
    }

    #[test]
    fn a_frame_of_the_recording_size_keeps_its_pixels() {
        let image = RgbImage::from_fn(4, 2, |x, y| Rgb([x as u8 * 10, y as u8 * 10, 7]));
        let pixels = decode(
            &encoded(image.clone(), ImageFormat::Png),
            FrameFormat::Png,
            4,
            2,
        )
        .expect("decodes");
        assert!(!pixels.resized);
        assert_eq!((pixels.source_width, pixels.source_height), (4, 2));
        assert_eq!(pixels.rgb, image.into_raw());
    }

    #[test]
    fn a_wider_frame_is_fitted_and_centred_on_black() {
        let image = RgbImage::from_pixel(8, 4, Rgb([255, 255, 255]));
        let pixels =
            decode(&encoded(image, ImageFormat::Png), FrameFormat::Png, 4, 4).expect("decodes");
        assert!(pixels.resized);
        assert_eq!((pixels.source_width, pixels.source_height), (8, 4));
        assert_eq!(pixels.rgb.len(), 4 * 4 * 3);
        let row = |y: usize| &pixels.rgb[y * 12..(y + 1) * 12];
        assert!(
            row(0).iter().all(|&value| value == 0),
            "the top row is padding"
        );
        assert!(
            row(1).iter().all(|&value| value == 255),
            "the middle rows are the image"
        );
        assert!(
            row(2).iter().all(|&value| value == 255),
            "the middle rows are the image"
        );
        assert!(
            row(3).iter().all(|&value| value == 0),
            "the bottom row is padding"
        );
    }

    #[test]
    fn jpeg_frames_decode_too() {
        let image = RgbImage::from_pixel(16, 16, Rgb([200, 30, 30]));
        let pixels = decode(
            &encoded(image, ImageFormat::Jpeg),
            FrameFormat::Jpeg,
            16,
            16,
        )
        .expect("decodes");
        let [red, green, blue] = [pixels.rgb[0], pixels.rgb[1], pixels.rgb[2]];
        assert!(
            red > 180 && green < 60 && blue < 60,
            "close to the source colour: {red} {green} {blue}"
        );
    }

    #[test]
    fn bytes_that_are_not_the_named_format_are_refused() {
        let png = encoded(RgbImage::new(2, 2), ImageFormat::Png);
        assert!(decode(&png, FrameFormat::Jpeg, 2, 2).is_err());
        assert!(decode(b"not an image", FrameFormat::Png, 2, 2).is_err());
        assert!(dimensions(b"not an image", FrameFormat::Jpeg).is_err());
    }

    #[test]
    fn fitting_keeps_proportions_and_never_enlarges() {
        assert_eq!(fit_within(800, 600, 200, 200), (200, 150));
        assert_eq!(fit_within(600, 800, 200, 200), (150, 200));
        assert_eq!(fit_within(100, 50, 200, 200), (100, 50), "never enlarged");
        assert_eq!(
            fit_within(10_000, 1, 100, 100),
            (100, 1),
            "at least one pixel"
        );
    }

    #[test]
    fn an_image_that_fits_in_its_own_format_is_returned_untouched() {
        let png = encoded(
            RgbImage::from_pixel(40, 30, Rgb([1, 2, 3])),
            ImageFormat::Png,
        );
        let fitted =
            fit(&png, FrameFormat::Png, request(100, 100, FrameFormat::Png)).expect("fits");
        assert_eq!(fitted.bytes, png, "the source's own bytes");
        let smaller =
            fit(&png, FrameFormat::Png, request(20, 20, FrameFormat::Jpeg)).expect("fits");
        assert_eq!(
            (smaller.width, smaller.height, smaller.source_width),
            (20, 15, 40)
        );
        assert_eq!(dimensions(&smaller.bytes, FrameFormat::Jpeg), Ok((20, 15)));
    }

    #[test]
    fn a_source_past_the_bounds_is_too_large_and_garbage_is_undecodable() {
        let png = encoded(RgbImage::new(64, 8), ImageFormat::Png);
        let tight = FitRequest {
            max_side: 32,
            ..request(10, 10, FrameFormat::Png)
        };
        assert!(matches!(
            fit(&png, FrameFormat::Png, tight),
            Err(ImageFailure::TooLarge(_))
        ));
        let small_budget = FitRequest {
            max_decode_bytes: 16,
            ..request(10, 10, FrameFormat::Png)
        };
        assert!(matches!(
            fit(&png, FrameFormat::Png, small_budget),
            Err(ImageFailure::TooLarge(_))
        ));
        assert!(matches!(
            fit(
                b"garbage",
                FrameFormat::Png,
                request(10, 10, FrameFormat::Png)
            ),
            Err(ImageFailure::Undecodable(_))
        ));
    }

    #[test]
    fn the_encoded_route_passes_matching_frames_as_they_came() {
        let jpeg = encoded(
            RgbImage::from_pixel(8, 6, Rgb([9, 9, 9])),
            ImageFormat::Jpeg,
        );
        let same = for_route(&jpeg, FrameFormat::Jpeg, FrameFormat::Jpeg, 8, 6).expect("ready");
        assert!(same.bytes.is_none() && !same.resized);
        let other_size =
            for_route(&jpeg, FrameFormat::Jpeg, FrameFormat::Jpeg, 4, 4).expect("ready");
        let converted = other_size.bytes.expect("converted");
        assert!(other_size.resized);
        assert_eq!(dimensions(&converted, FrameFormat::Jpeg), Ok((4, 4)));
        let png = encoded(RgbImage::from_pixel(8, 6, Rgb([9, 9, 9])), ImageFormat::Png);
        let other_format =
            for_route(&png, FrameFormat::Png, FrameFormat::Jpeg, 8, 6).expect("ready");
        assert!(!other_format.resized);
        assert_eq!(
            dimensions(&other_format.bytes.expect("converted"), FrameFormat::Jpeg),
            Ok((8, 6))
        );
    }
}

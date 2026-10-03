//! Turns a captured image into the pixels the encoder reads.
//!
//! A frame of another size is scaled to fit the recording with its proportions kept and centred on black, so a
//! page is never stretched. Decoding happens once per frame, here or in the encoder, whichever process reads
//! the image; doing it here lets PNG and JPEG frames share one recording and lets a frame of any size join it.

use std::io::Cursor;

use image::imageops::{self, FilterType};
use image::{ImageFormat, ImageReader, Limits, RgbImage};

use crate::protocol::FrameFormat;

/// The widest or tallest image the process decodes. Larger ones are refused before their pixels are allocated.
const MAX_SIDE: u32 = 16_384;
const MAX_DECODE_BYTES: u64 = 512 * 1024 * 1024;

/// A frame's pixels at the recording's size, three bytes per pixel, rows top to bottom.
#[derive(Debug)]
pub struct Pixels {
    pub rgb: Vec<u8>,
    pub resized: bool,
}

pub fn decode(
    bytes: &[u8],
    format: FrameFormat,
    width: u32,
    height: u32,
) -> Result<Pixels, String> {
    let format = match format {
        FrameFormat::Png => ImageFormat::Png,
        FrameFormat::Jpeg => ImageFormat::Jpeg,
    };
    let mut reader = ImageReader::with_format(Cursor::new(bytes), format);
    let mut limits = Limits::default();
    limits.max_image_width = Some(MAX_SIDE);
    limits.max_image_height = Some(MAX_SIDE);
    limits.max_alloc = Some(MAX_DECODE_BYTES);
    reader.limits(limits);
    let image = reader.decode().map_err(|error| error.to_string())?;
    if image.width() == width && image.height() == height {
        return Ok(Pixels {
            rgb: image.into_rgb8().into_raw(),
            resized: false,
        });
    }
    let scaled = image
        .resize(width, height, FilterType::Triangle)
        .into_rgb8();
    let mut canvas = RgbImage::new(width, height);
    let left = (width - scaled.width().min(width)) / 2;
    let top = (height - scaled.height().min(height)) / 2;
    imageops::replace(&mut canvas, &scaled, i64::from(left), i64::from(top));
    Ok(Pixels {
        rgb: canvas.into_raw(),
        resized: true,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::{DynamicImage, Rgb};

    fn encoded(image: RgbImage, format: ImageFormat) -> Vec<u8> {
        let mut bytes = Cursor::new(Vec::new());
        DynamicImage::ImageRgb8(image)
            .write_to(&mut bytes, format)
            .expect("encodes");
        bytes.into_inner()
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
        assert_eq!(pixels.rgb, image.into_raw());
    }

    #[test]
    fn a_wider_frame_is_fitted_and_centred_on_black() {
        let image = RgbImage::from_pixel(8, 4, Rgb([255, 255, 255]));
        let pixels =
            decode(&encoded(image, ImageFormat::Png), FrameFormat::Png, 4, 4).expect("decodes");
        assert!(pixels.resized);
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
    }
}

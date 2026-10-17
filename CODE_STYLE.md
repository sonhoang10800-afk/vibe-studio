# House Style (Vibe Studio)

Đây là tiêu chí thiết kế và review, không phải lệnh formatter. Khi sửa code, ưu tiên làm code rõ hơn mà vẫn giữ nguyên hành vi.

## 1. Luật Chung

- Đọc luồng gọi và helper hiện có (`src/lib/utils.ts`) trước khi thêm abstraction.
- Một nguồn sự thật cho mỗi trạng thái; không tạo bản sao chỉ để tiện dùng.
- Tên phải nói rõ vai trò và side effect tại nơi gọi.
- Guard clause và luồng thẳng được ưu tiên hơn nesting sâu.
- Comment giải thích `why`, không chép lại `what` mà code đã nói rõ.
- Không thêm tính năng dự phòng, dependency hoặc refactor ngoài phạm vi.
- Refactor phải giữ hành vi; nếu thiếu test, thêm một smoke check nhỏ trước khi đổi cấu trúc.

## 2. Chuẩn TypeScript & Next.js

- Dùng type và module boundary để làm rõ contract; không che lỗi bằng `any`, `@ts-ignore` hoặc `catch` rỗng.
- Component phân tách rõ ràng:
  - `src/components/ui/`: Dumb components (chỉ nhận props, render giao diện, không side effects).
  - `src/features/<domain>/`: Domain components, hooks và state cục bộ.
  - `src/app/`: Next.js App Router pages và layouts (Server Components mặc định, thêm `"use client"` chỉ khi cần tương tác).
- Tailwind CSS: ưu tiên semantic utility classes; dùng `cn(...)` từ `@/lib/utils` để merge dynamic classes. Tránh class trùng lặp hoặc inline styles không cần thiết.

## 3. Definition of Done

Một thay đổi có gu phải có diff nhỏ, không có file ngoài phạm vi, không làm giảm code health, có kiểm tra phù hợp (`rtk npm test`, `rtk npm run typecheck`) và không còn `TODO` hoặc placeholder chưa hoàn thiện.

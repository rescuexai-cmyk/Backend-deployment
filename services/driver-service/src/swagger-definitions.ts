/**
 * @openapi
 * components:
 *   schemas:
 *     DriverProfile:
 *       type: object
 *       properties:
 *         driver_id:
 *           type: string
 *         email:
 *           type: string
 *         name:
 *           type: string
 *         phone:
 *           type: string
 *         license_number:
 *           type: string
 *         vehicle_info:
 *           type: object
 *           properties:
 *             make:
 *               type: string
 *             model:
 *               type: string
 *             year:
 *               type: integer
 *             license_plate:
 *               type: string
 *             color:
 *               type: string
 *         documents:
 *           type: object
 *           properties:
 *             license_verified:
 *               type: boolean
 *             insurance_verified:
 *               type: boolean
 *             vehicle_registration_verified:
 *               type: boolean
 *             all_verified:
 *               type: boolean
 *             pending_count:
 *               type: integer
 *         onboarding:
 *           type: object
 *           properties:
 *             status:
 *               type: string
 *             is_verified:
 *               type: boolean
 *             documents_submitted:
 *               type: boolean
 *             documents_verified:
 *               type: boolean
 *             can_start_rides:
 *               type: boolean
 *             verification_notes:
 *               type: string
 *         status:
 *           type: string
 *           enum: [active, inactive, suspended]
 *         rating:
 *           type: number
 *         rating_count:
 *           type: integer
 *         total_trips:
 *           type: integer
 *         earnings:
 *           type: object
 *           properties:
 *             today:
 *               type: number
 *             week:
 *               type: number
 *             month:
 *               type: number
 *             total:
 *               type: number
 *         hours_online:
 *           type: number
 *         is_online:
 *           type: boolean
 *         current_location:
 *           type: object
 *           properties:
 *             latitude:
 *               type: number
 *             longitude:
 *               type: number
 *         notifications_enabled:
 *           type: boolean
 *     
 *     DriverPenalty:
 *       type: object
 *       properties:
 *         id:
 *           type: string
 *         amount:
 *           type: number
 *         reason:
 *           type: string
 *         status:
 *           type: string
 *           enum: [PENDING, PAID]
 *         createdAt:
 *           type: string
 *           format: date-time
 *         paidAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *     
 *     EarningsBreakdown:
 *       type: object
 *       properties:
 *         base_fare:
 *           type: number
 *         distance_fare:
 *           type: number
 *         time_fare:
 *           type: number
 *         surge_bonus:
 *           type: number
 *         gross_amount:
 *           type: number
 *         platform_fee:
 *           type: number
 *         net_amount:
 *           type: number
 *     
 *     PayoutAccountRequest:
 *       type: object
 *       required: [accountType]
 *       properties:
 *         accountType:
 *           type: string
 *           enum: [BANK_ACCOUNT, UPI]
 *         bankName:
 *           type: string
 *         accountNumber:
 *           type: string
 *           minLength: 9
 *           maxLength: 18
 *         ifscCode:
 *           type: string
 *           pattern: '^[A-Z]{4}0[A-Z0-9]{6}$'
 *         accountHolderName:
 *           type: string
 *           minLength: 2
 *           maxLength: 100
 *         upiId:
 *           type: string
 *           pattern: '^[\w.-]+@[\w]+$'
 *     
 *     WalletBalance:
 *       type: object
 *       properties:
 *         balance:
 *           type: object
 *           properties:
 *             available:
 *               type: number
 *             pending:
 *               type: number
 *             hold:
 *               type: number
 *             effective:
 *               type: number
 *         stats:
 *           type: object
 *           properties:
 *             totalEarned:
 *               type: number
 *             totalWithdrawn:
 *               type: number
 *             unpaidPenalties:
 *               type: number
 *             pendingWithdrawals:
 *               type: number
 *         minimumWithdrawal:
 *           type: number
 *         lastPayoutAt:
 *           type: string
 *           format: date-time
 *           nullable: true
 *     
 *     DriverTrip:
 *       type: object
 *       properties:
 *         trip_id:
 *           type: string
 *         passenger_name:
 *           type: string
 *         passenger_phone:
 *           type: string
 *         pickup_address:
 *           type: string
 *         drop_address:
 *           type: string
 *         distance:
 *           type: number
 *         duration:
 *           type: integer
 *         fare:
 *           type: number
 *         status:
 *           type: string
 *         rating:
 *           type: number
 *           nullable: true
 *         feedback:
 *           type: string
 *           nullable: true
 *         cancelled_by:
 *           type: string
 *           nullable: true
 *         started_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         completed_at:
 *           type: string
 *           format: date-time
 *           nullable: true
 *         created_at:
 *           type: string
 *           format: date-time
 *     
 *     OnboardingStatus:
 *       type: object
 *       properties:
 *         driver_id:
 *           type: string
 *         onboarding_status:
 *           type: string
 *           enum: [EMAIL_COLLECTION, LANGUAGE_SELECTION, EARNING_SETUP, LICENSE_UPLOAD, PROFILE_PHOTO, PHOTO_CONFIRMATION, DOCUMENT_UPLOAD, DOCUMENT_VERIFICATION, COMPLETED]
 *         current_step:
 *           type: string
 *         is_verified:
 *           type: boolean
 *         is_onboarding_complete:
 *           type: boolean
 *         full_name:
 *           type: string
 *         email:
 *           type: string
 *         phone:
 *           type: string
 *         vehicle_type:
 *           type: string
 *         vehicle_number:
 *           type: string
 *         documents:
 *           type: object
 *           properties:
 *             required:
 *               type: array
 *               items:
 *                 type: string
 *             uploaded:
 *               type: array
 *               items:
 *                 type: string
 *             verified:
 *               type: array
 *               items:
 *                 type: string
 *             pending:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                   url:
 *                     type: string
 *                     nullable: true
 *                   uploaded_at:
 *                     type: string
 *                     format: date-time
 *             flagged:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                   url:
 *                     type: string
 *                     nullable: true
 *                   rejection_reason:
 *                     type: string
 *                     nullable: true
 *             details:
 *               type: array
 *               items:
 *                 type: object
 *                 properties:
 *                   type:
 *                     type: string
 *                   url:
 *                     type: string
 *                     nullable: true
 *                   is_verified:
 *                     type: boolean
 *         verification_progress:
 *           type: integer
 *           minimum: 0
 *           maximum: 100
 *         can_start_rides:
 *           type: boolean
 */

export {};
